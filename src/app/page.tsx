// / — role-aware home (docs/DESIGN-SYSTEM.md).
// The logged-in role decides the default home: executives land on the money
// view, everyone else on the operational command center. Roles are REAL
// — the old role-switcher toggle is gone.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { HomeClient, type HomeView } from '@/components/sentinel/home-client';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  const view: HomeView = user.role === 'executive' ? 'executive' : 'engineer';
  return (
    <HomeClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
      initialView={view}
    />
  );
}
