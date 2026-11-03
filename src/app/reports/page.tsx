// /reports — report generation + schedules (docs/DESIGN-SYSTEM.md).
// Persian PDFs for the CEO and SLA statements for clients: generate on demand,
// manage cron schedules, download from the archive.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { ReportsClient } from '@/components/sentinel/reports-client';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <ReportsClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
