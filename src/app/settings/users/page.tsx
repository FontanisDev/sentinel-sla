// /settings/users — operator account administration.
// Server wrapper resolves the session; the client body owns the table+forms.
// The API layer is the authority: /api/users 403s below admin, only the
// owner can mint/modify owners or delete accounts, last-owner is protected.

import { redirect } from 'next/navigation';
import { resolveSessionUserFromCookies } from '@/server/auth/session';
import { UsersClient } from '@/components/sentinel/settings/users-client';

export const dynamic = 'force-dynamic';

export default async function UsersSettingsPage() {
  const user = await resolveSessionUserFromCookies();
  if (!user) redirect('/login');
  return (
    <UsersClient
      caller={{ name: user.name || user.email, email: user.email, role: user.role }}
    />
  );
}
