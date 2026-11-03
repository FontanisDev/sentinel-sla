// /contracts — client contracts page (docs/DESIGN-SYSTEM.md).
// Per-service contract view: target, penalty scheme, this month's compliance
// and the projected penalty — every figure with its formula evidence.
// Primary users: executive, admin (money-first view, viewer-friendly read).

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { ContractsClient } from '@/components/sentinel/contracts-client';

export const dynamic = 'force-dynamic';

export default async function ContractsPage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <ContractsClient
      user={{ name: user.name || user.email, email: user.email, role: user.role, locale: user.locale }}
    />
  );
}
