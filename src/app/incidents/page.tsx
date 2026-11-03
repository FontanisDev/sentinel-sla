// /incidents — the incident ledger page (docs/DESIGN-SYSTEM.md).
// Route refactor: proven IncidentTable + detail dialog under the new AppShell;
// timeline/evidence panels and the DataTable rebuild land next.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { IncidentsClient } from '@/components/sentinel/incidents-client';

export const dynamic = 'force-dynamic';

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const [{ q }, user] = await Promise.all([searchParams, resolveSessionUserFromCookies()]);
  if (!user) redirect('/login');
  return (
    <IncidentsClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
      initialQuery={q ?? ''}
    />
  );
}
