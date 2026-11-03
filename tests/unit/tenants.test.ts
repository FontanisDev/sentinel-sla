// Characterisation tests for tenant helpers .

import { describe, expect, it } from 'vitest';
import { parseTenantParam, toTenantDTO, type TenantRow } from '@/server/tenants';

describe('parseTenantParam (characterisation)', () => {
  it('maps absent / empty / all to fleet-wide null', () => {
    expect(parseTenantParam(null)).toBeNull();
    expect(parseTenantParam(undefined)).toBeNull();
    expect(parseTenantParam('')).toBeNull();
    expect(parseTenantParam('   ')).toBeNull();
    expect(parseTenantParam('all')).toBeNull();
    expect(parseTenantParam('ALL')).toBeNull();
    expect(parseTenantParam('All')).toBeNull();
  });

  it('keeps any other value as a tenant id, trimmed', () => {
    expect(parseTenantParam('t-1')).toBe('t-1');
    expect(parseTenantParam('  t-1  ')).toBe('t-1');
    // 'all-ish' strings that are not exactly 'all' are ids
    expect(parseTenantParam('alphabet')).toBe('alphabet');
  });
});

describe('toTenantDTO (characterisation)', () => {
  it('maps a full row and coerces servicesCount to number', () => {
    const row: TenantRow = {
      id: 't1',
      key: 'bank-mellat',
      name: 'Bank Mellat',
      nameFa: 'بانک ملت',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      servicesCount: 3,
    };
    const dto = toTenantDTO(row);
    expect(dto).toEqual({
      id: 't1',
      key: 'bank-mellat',
      name: 'Bank Mellat',
      nameFa: 'بانک ملت',
      servicesCount: 3,
    });
  });

  it('normalizes missing / string / null edge inputs', () => {
    const base: TenantRow = {
      id: 't2',
      key: 'psp-x',
      name: 'PSP X',
      nameFa: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      servicesCount: '7',
    };
    const dto = toTenantDTO(base);
    expect(dto.servicesCount).toBe(7); // string → number
    expect(dto.nameFa).toBeNull();

    const none = toTenantDTO({ ...base, servicesCount: undefined });
    expect(none.servicesCount).toBe(0);
  });
});
