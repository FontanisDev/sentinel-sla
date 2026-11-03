// /executive — the money-first home (docs/DESIGN-SYSTEM.md).
// A separate page, never a toggle: fleet SLA compliance, client exposure and
// the cost of the last incident, in Tomans. Read-only — every role may look,
// only real roles decide the default home.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { HomeClient } from '@/components/sentinel/home-client';

export const dynamic = 'force-dynamic';

export default async function ExecutiveHomePage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <HomeClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
      initialView="executive"
    />
  );
}
