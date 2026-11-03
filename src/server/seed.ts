// Sentinel-SLA — database seeding
// Creates the 6 baseline fintech services and the 3 baseline tenants when the
// tables are empty, and backfills tenant assignments for still-unassigned
// seeded services. Idempotent and safe under concurrent first-boot calls
// (instrumentation + first API hit).

import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import { backfillTenantAssignments, createTenantRow, getTenantByKey } from '@/server/tenants';

interface SeedService {
  key: string;
  name: string;
  nameFa: string;
  tier: string;
  endpoint: string;
  baseLatencyMs: number;
  tps: number;
  avgTransactionValue: number;
  slaTarget: number;
  penaltyBase: number;
  penaltyPerMinute: number;
  criticality: string;
}

const SEED_SERVICES: SeedService[] = [
  {
    key: 'payment-gateway',
    name: 'Payment Gateway',
    nameFa: 'دروازه پرداخت',
    tier: 'tier-1',
    endpoint: 'https://api.psp.example.ir/v1/health',
    baseLatencyMs: 95,
    tps: 85,
    avgTransactionValue: 320000,
    slaTarget: 0.9995,
    penaltyBase: 120000000,
    penaltyPerMinute: 25000000,
    criticality: 'critical',
  },
  {
    key: 'core-banking',
    name: 'Core Banking API',
    nameFa: 'هسته بانکی',
    tier: 'tier-1',
    endpoint: 'https://core.bank.example.ir/api/heartbeat',
    baseLatencyMs: 140,
    tps: 40,
    avgTransactionValue: 950000,
    slaTarget: 0.9999,
    penaltyBase: 400000000,
    penaltyPerMinute: 80000000,
    criticality: 'critical',
  },
  {
    key: 'kyc',
    name: 'KYC Service',
    nameFa: 'احراز هویت',
    tier: 'tier-2',
    endpoint: 'https://kyc.example.ir/status',
    baseLatencyMs: 210,
    tps: 8,
    avgTransactionValue: 95000,
    slaTarget: 0.999,
    penaltyBase: 60000000,
    penaltyPerMinute: 9000000,
    criticality: 'high',
  },
  {
    key: 'fraud-scoring',
    name: 'Fraud Scoring',
    nameFa: 'تشخیص تقلب',
    tier: 'tier-2',
    endpoint: 'https://risk.example.ir/health',
    baseLatencyMs: 60,
    tps: 120,
    avgTransactionValue: 12000,
    slaTarget: 0.999,
    penaltyBase: 90000000,
    penaltyPerMinute: 14000000,
    criticality: 'high',
  },
  {
    key: 'otp-delivery',
    name: 'OTP Delivery',
    nameFa: 'سرویس پیامک',
    tier: 'tier-2',
    endpoint: 'https://sms.example.ir/ping',
    baseLatencyMs: 180,
    tps: 25,
    avgTransactionValue: 7500,
    slaTarget: 0.995,
    penaltyBase: 45000000,
    penaltyPerMinute: 6000000,
    criticality: 'medium',
  },
  {
    key: 'wallet',
    name: 'Wallet Service',
    nameFa: 'کیف پول',
    tier: 'tier-3',
    endpoint: 'https://wallet.example.ir/health',
    baseLatencyMs: 110,
    tps: 30,
    avgTransactionValue: 410000,
    slaTarget: 0.999,
    penaltyBase: 75000000,
    penaltyPerMinute: 12000000,
    criticality: 'high',
  },
];

let seedPromise: Promise<void> | null = null;

interface SeedTenant {
  key: string;
  name: string;
  nameFa: string;
  serviceKeys: string[];
}

// v2 multi-tenancy baseline: the 6-service fleet is split across 3 client
// companies (post-MVP multi-customer requirement).
const SEED_TENANTS: SeedTenant[] = [
  {
    key: 'sabz-pay',
    name: 'Sabz Pay Gateway Co.',
    nameFa: 'شرکت هاب پرداخت سبز',
    serviceKeys: ['payment-gateway', 'wallet', 'otp-delivery'],
  },
  {
    key: 'novin-bank',
    name: 'Novin Digital Banking',
    nameFa: 'بانکداری نوین دیجیتال',
    serviceKeys: ['core-banking', 'kyc'],
  },
  {
    key: 'hoosh-risk',
    name: 'Hoosh Risk Analytics',
    nameFa: 'هوش ریسک سامانه',
    serviceKeys: ['fraud-scoring'],
  },
];

async function doSeed(): Promise<void> {
  const count = await db.service.count();
  if (count > 0) {
    await ensureTenantsSeeded();
    return;
  }
  try {
    await db.service.createMany({ data: SEED_SERVICES });
    console.log(`[sentinel] seeded ${SEED_SERVICES.length} services`);
  } catch (err) {
    // Lost a concurrent seeding race (unique key) — the other caller won; that is fine.
    const code = (err as { code?: string }).code;
    if (code !== 'P2002') throw err;
  }
  await ensureTenantsSeeded();
}

/** Create the baseline tenants (idempotent) and assign still-unassigned services. */
async function ensureTenantsSeeded(): Promise<void> {
  for (const t of SEED_TENANTS) {
    const existing = await getTenantByKey(t.key);
    if (existing) continue;
    try {
      await createTenantRow({ key: t.key, name: t.name, nameFa: t.nameFa });
    } catch (err) {
      // Lost a concurrent insert race on the unique key — the other caller won.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
  // Backfill keyed by service key, only where tenantId is still NULL (race-safe
  // SQL guard inside). Never creates additional services.
  const mapping: Record<string, string> = {};
  for (const t of SEED_TENANTS) {
    for (const k of t.serviceKeys) mapping[k] = t.key;
  }
  const assigned = await backfillTenantAssignments(mapping);
  if (assigned > 0) console.log(`[sentinel] assigned ${assigned} services to their tenants`);
}

/** Ensure the baseline services exist. Memoized per process; re-checks count on each new call. */
export function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = doSeed().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}
