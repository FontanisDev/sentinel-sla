// /api/tenants — GET: list tenants with live servicesCount | POST: create a tenant.
//
// Response shapes follow the v2 contract convention (bare payloads):
//   GET  → TenantDTO[]
//   POST → 201 + TenantDTO (bare), 409 duplicate key, 400 validation.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { createTenantSchema } from '@/server/validation';
import { createTenantRow, listTenantDTOs, toTenantDTO } from '@/server/tenants';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    // ensureSeeded() runs inside engine init (idempotent): tenants exist even
    // when this endpoint is the first thing hit after a cold boot.
    await getEngine().ensureInit();
    return NextResponse.json(await listTenantDTOs());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'admin'); // phase-2 authz
    const parsed = createTenantSchema.parse(await readJsonBody(req));
    const row = await createTenantRow({
      key: parsed.key,
      name: parsed.name,
      nameFa: parsed.nameFa ?? null,
    });
    return NextResponse.json(toTenantDTO(row), { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
