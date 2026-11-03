// Sentinel-SLA — guided setup: the getting-started onboarding status.
//
// Pure core (computeOnboardingSteps) turns injected counts into an ordered
// checklist; the route gathers the REAL counts (one raw-SQL COUNT per table)
// and calls it. Nothing is guessed: every step's done-state is a count or an
// explicit configuration lookup, and the demo mode is reported honestly
// (the simulation IS the signal source in demo — labelled, never passed off
// as a live Prometheus connection).
//
// Step order mirrors a new operator's actual journey:
//   signal source → tenants → services → client coverage → channels → report.

export interface OnboardingCounts {
  /** Prometheus connection stored (live ingestion configured). */
  prometheusConfigured: boolean;
  /** config mode: 'demo' | 'live' — demo is a legitimate signal source. */
  mode: 'demo' | 'live';
  tenants: number;
  /** services excluding the self-test synthetic target. */
  services: number;
  /** services bound to a client tenant (contract coverage). */
  servicesWithTenant: number;
  channels: number;
  reports: number;
}

export interface OnboardingStep {
  id: 'prometheus' | 'tenants' | 'services' | 'clients' | 'channels' | 'report';
  done: boolean;
  /** live count behind the step (null for the config lookup step). */
  count: number | null;
  /** where the operator goes to work on this step. */
  href: string;
  /**
   * demo mode marker for the signal-source step: the UI shows "using the
   * demo simulation" instead of a connected Prometheus — honest state.
   */
  demoSignalSource: boolean;
}

export function computeOnboardingSteps(c: OnboardingCounts): OnboardingStep[] {
  return [
    {
      id: 'prometheus',
      done: c.prometheusConfigured || c.mode === 'demo',
      count: null,
      href: '/settings/integrations',
      demoSignalSource: !c.prometheusConfigured && c.mode === 'demo',
    },
    { id: 'tenants', done: c.tenants >= 1, count: c.tenants, href: '/settings', demoSignalSource: false },
    { id: 'services', done: c.services >= 1, count: c.services, href: '/services', demoSignalSource: false },
    { id: 'clients', done: c.servicesWithTenant >= 1, count: c.servicesWithTenant, href: '/contracts', demoSignalSource: false },
    { id: 'channels', done: c.channels >= 1, count: c.channels, href: '/alerting/channels', demoSignalSource: false },
    { id: 'report', done: c.reports >= 1, count: c.reports, href: '/reports', demoSignalSource: false },
  ];
}

export function onboardingProgress(steps: OnboardingStep[]): { done: number; total: number; allDone: boolean } {
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, allDone: done === steps.length };
}
