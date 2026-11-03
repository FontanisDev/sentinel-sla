// Characterisation tests for maintenance window DTO mapping .

import { describe, expect, it } from 'vitest';
import { toMaintenanceWindowDTO, type MaintenanceWindowRow } from '@/server/maintenance';

function makeRow(overrides: Partial<MaintenanceWindowRow> = {}): MaintenanceWindowRow {
  return {
    id: 'mw-1',
    serviceId: 'svc-1',
    serviceName: 'Payment Gateway',
    tenantId: 't1',
    reason: 'Planned database upgrade',
    status: 'active',
    startAt: new Date('2026-10-08T06:00:00Z'),
    endAt: new Date('2026-10-08T08:00:00Z'),
    createdAt: new Date('2026-10-07T06:00:00Z'),
    createdBy: 'admin',
    suppressedAlerts: 4,
    ...overrides,
  } as MaintenanceWindowRow;
}

describe('toMaintenanceWindowDTO (characterisation)', () => {
  it('maps a full active window, dates → ISO strings, counts → number', () => {
    const dto = toMaintenanceWindowDTO(makeRow());
    expect(dto).toEqual({
      id: 'mw-1',
      serviceId: 'svc-1',
      serviceName: 'Payment Gateway',
      tenantId: 't1',
      reason: 'Planned database upgrade',
      status: 'active',
      startAt: '2026-10-08T06:00:00.000Z',
      endAt: '2026-10-08T08:00:00.000Z',
      createdAt: '2026-10-07T06:00:00.000Z',
      createdBy: 'admin',
      suppressedAlerts: 4,
    });
  });

  it('fleet-wide window (no service) maps service fields to null', () => {
    const dto = toMaintenanceWindowDTO(
      makeRow({ serviceId: null, serviceName: null, tenantId: null }),
    );
    expect(dto.serviceId).toBeNull();
    expect(dto.serviceName).toBeNull();
    expect(dto.tenantId).toBeNull();
  });

  it('invalid dates fall back to epoch ISO, missing counts to 0', () => {
    const dto = toMaintenanceWindowDTO(makeRow({ startAt: 'not-a-date', suppressedAlerts: null }));
    expect(dto.startAt).toBe('1970-01-01T00:00:00.000Z');
    expect(dto.suppressedAlerts).toBe(0);
  });
});
