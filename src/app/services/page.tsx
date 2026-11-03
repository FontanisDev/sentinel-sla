// /services — service registry page (docs/DESIGN-SYSTEM.md).
// this page reuses the proven ServiceTable + the
// incidents dialog under the new AppShell; the DataTable rebuild (sort,
// filter, column picker, density) lands in the next increment.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { ServicesClient } from '@/components/sentinel/services-client';

export const dynamic = 'force-dynamic';

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const [{ q }, user] = await Promise.all([searchParams, resolveSessionUserFromCookies()]);
  if (!user) redirect('/login');
  return (
    <ServicesClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
      initialQuery={q ?? ''}
    />
  );
}
