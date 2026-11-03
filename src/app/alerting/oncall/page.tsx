// /alerting/oncall — on-call rotation + fleet escalation ladder.
// Server wrapper resolves the session; client body owns tables + forms.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { OncallClient } from '@/components/sentinel/alerting/oncall-client';

export const dynamic = 'force-dynamic';

export default async function AlertingOncallPage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <OncallClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
