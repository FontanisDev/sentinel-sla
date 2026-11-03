// /services/[key] — full-page service detail (design system §5).
// Thin server wrapper: auth gate, then the client component fetches
// GET /api/services/[key] (same authz as every other surface).

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { ServiceDetailClient } from '@/components/sentinel/service-detail-client';

export const dynamic = 'force-dynamic';

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  const { key } = await params;
  return (
    <ServiceDetailClient
      serviceKey={key}
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
