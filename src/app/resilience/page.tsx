// /resilience — chaos experiments, weekly self-test history, MTTD gate trend
// (docs/DESIGN-SYSTEM.md). Server wrapper resolves the session and
// hands the user to the shell; the client body polls /api/resilience.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { ResilienceClient } from '@/components/sentinel/resilience-client';

export const dynamic = 'force-dynamic';

export default async function ResiliencePage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <ResilienceClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
