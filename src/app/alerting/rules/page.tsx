// /alerting/rules — policy rules evaluated by the engine every ~5 s.
// Server wrapper resolves the session; client body owns the table + forms.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { RulesClient } from '@/components/sentinel/alerting/rules-client';

export const dynamic = 'force-dynamic';

export default async function AlertingRulesPage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <RulesClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
