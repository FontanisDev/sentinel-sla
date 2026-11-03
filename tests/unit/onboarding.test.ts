// Guided setup — the pure onboarding checklist. Goldens pin the exact
// step order and done-states for the empty instance, the demo instance and
// the fully-configured one; fast-check pins the progress invariants
// (allDone ⟺ every step done; done ≤ total; a count step is done iff its
// count ≥ 1) over arbitrary count combinations.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeOnboardingSteps, onboardingProgress, type OnboardingCounts } from '@/server/onboarding';

const base: OnboardingCounts = {
  prometheusConfigured: false,
  mode: 'demo',
  tenants: 0,
  services: 0,
  servicesWithTenant: 0,
  channels: 0,
  reports: 0,
};

describe('onboarding checklist', () => {
  it('step order mirrors the operator journey (fixed ids)', () => {
    const ids = computeOnboardingSteps(base).map((s) => s.id);
    expect(ids).toEqual(['prometheus', 'tenants', 'services', 'clients', 'channels', 'report']);
  });

  it('empty demo instance: only the signal source counts as set, and it is labelled demo', () => {
    const steps = computeOnboardingSteps(base);
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId['prometheus'].done).toBe(true);
    expect(byId['prometheus'].demoSignalSource).toBe(true);
    expect(byId['tenants'].done).toBe(false);
    expect(byId['services'].done).toBe(false);
    expect(byId['clients'].done).toBe(false);
    expect(byId['channels'].done).toBe(false);
    expect(byId['report'].done).toBe(false);
    expect(onboardingProgress(steps)).toEqual({ done: 1, total: 6, allDone: false });
  });

  it('live mode without a stored connection: signal source is honestly NOT done', () => {
    const steps = computeOnboardingSteps({ ...base, mode: 'live' });
    const prometheus = steps[0];
    expect(prometheus.done).toBe(false);
    expect(prometheus.demoSignalSource).toBe(false);
  });

  it('demo mode WITH a stored connection: done and not labelled demo', () => {
    const steps = computeOnboardingSteps({ ...base, prometheusConfigured: true });
    expect(steps[0].done).toBe(true);
    expect(steps[0].demoSignalSource).toBe(false);
  });

  it('fully configured instance: allDone', () => {
    const steps = computeOnboardingSteps({
      prometheusConfigured: true,
      mode: 'live',
      tenants: 2,
      services: 6,
      servicesWithTenant: 5,
      channels: 1,
      reports: 3,
    });
    expect(onboardingProgress(steps)).toEqual({ done: 6, total: 6, allDone: true });
    expect(steps.every((s) => s.done)).toBe(true);
  });

  it('deep links point at the operator surface for each step', () => {
    const hrefs = computeOnboardingSteps(base).map((s) => s.href);
    expect(hrefs).toEqual([
      '/settings/integrations',
      '/settings',
      '/services',
      '/contracts',
      '/alerting/channels',
      '/reports',
    ]);
  });

  it('fast-check: count steps are done iff count ≥ 1; progress invariants hold', () => {
    const nat = fc.nat({ max: 50 });
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom('demo', 'live'),
        nat, nat, nat, nat, nat,
        (prometheusConfigured, mode, tenants, services, servicesWithTenant, channels, reports) => {
          const steps = computeOnboardingSteps({
            prometheusConfigured,
            mode: mode as 'demo' | 'live',
            tenants,
            services,
            servicesWithTenant,
            channels,
            reports,
          });
          const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
          expect(byId['tenants'].done).toBe(tenants >= 1);
          expect(byId['services'].done).toBe(services >= 1);
          expect(byId['clients'].done).toBe(servicesWithTenant >= 1);
          expect(byId['channels'].done).toBe(channels >= 1);
          expect(byId['report'].done).toBe(reports >= 1);
          const p = onboardingProgress(steps);
          expect(p.total).toBe(6);
          expect(p.done).toBeLessThanOrEqual(p.total);
          expect(p.allDone).toBe(steps.every((s) => s.done));
          expect(p.allDone).toBe(p.done === p.total);
        },
      ),
    );
  });
});
