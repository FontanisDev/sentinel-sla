// /incidents/[id] — full-page incident detail (design system §5).
// Thin server wrapper: auth gate, then the client component fetches
// GET /api/incidents/[id] (same authz as every other surface).

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { IncidentDetailClient } from '@/components/sentinel/incident-detail-client';

export const dynamic = 'force-dynamic';

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  const { id } = await params;
  return (
    <IncidentDetailClient
      id={id}
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
