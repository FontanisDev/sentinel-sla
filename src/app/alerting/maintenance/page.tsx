// /alerting/maintenance — planned-work windows. Server wrapper resolves
// the session; client body reuses the shared MaintenancePanel.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { MaintenanceClient } from '@/components/sentinel/alerting/maintenance-client';

export const dynamic = 'force-dynamic';

export default async function AlertingMaintenancePage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <MaintenanceClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
