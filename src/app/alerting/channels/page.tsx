// /alerting/channels — alerting IA: notification channels with test-send
// and the real delivery log, plus the outbox and the executive digest
// schedule. Server wrapper resolves the session; the client body is the
// extracted NotificationsBody (one source of truth with the legacy route).

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { ChannelsClient } from '@/components/sentinel/alerting/channels-client';

export const dynamic = 'force-dynamic';

export default async function AlertingChannelsPage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <ChannelsClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
