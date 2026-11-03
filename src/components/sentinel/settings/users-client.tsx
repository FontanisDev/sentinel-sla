'use client';

// /settings/users — operator account administration (admin+).
// Server-enforced: /api/users 403s below admin and only the owner can touch
// owner accounts or delete. This page is the lens, not the authority.
// Every mutation shown here is audit-logged server-side (user.*).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/sentinel/data-table';
import { EmptyState } from '@/components/sentinel/empty-state';

interface UserDTO {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'engineer' | 'executive' | 'viewer';
  locale: 'en' | 'fa';
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  memberships: { tenantId: string; role: string }[];
}

interface TenantOption {
  id: string;
  name: string;
}

type Role = UserDTO['role'];
const GLOBAL_ROLES: Role[] = ['owner', 'admin', 'engineer', 'executive', 'viewer'];
const MEMBERSHIP_ROLES = ['tenant-admin', 'engineer', 'executive', 'viewer'] as const;

const ROLE_TONE: Record<Role, string> = {
  owner: 'border-critical/40 bg-critical/10 text-critical',
  admin: 'border-primary/40 bg-primary/10 text-brand-ink',
  engineer: 'border-success/40 bg-success/10 text-success',
  executive: 'border-accent/40 bg-accent/10 text-accent-foreground',
  viewer: 'border-border bg-muted/40 text-muted-foreground',
};

interface CreateForm {
  name: string;
  email: string;
  password: string;
  role: Role;
  locale: 'en' | 'fa';
}

const EMPTY_CREATE: CreateForm = {
  name: '',
  email: '',
  password: '',
  role: 'viewer',
  locale: 'en',
};

/** tenancy picker state: tenantId → membership role */
type MembershipDraft = Record<string, (typeof MEMBERSHIP_ROLES)[number]>;

export function UsersClient({
  caller,
}: {
  caller: { name: string; email: string; role: string };
}) {
  const { t } = useLang();
  const [users, setUsers] = useState<UserDTO[] | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [memberships, setMemberships] = useState<MembershipDraft>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // per-user dialogs
  const [resetTarget, setResetTarget] = useState<UserDTO | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<UserDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserDTO | null>(null);

  const isOwner = caller.role === 'owner';

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      if (res.ok) {
        setUsers((await res.json()) as UserDTO[]);
        setPageError(null);
      } else {
        setUsers((prev) => prev ?? []);
        setPageError(`HTTP ${res.status}`);
      }
    } catch {
      setUsers((prev) => prev ?? []);
      setPageError('network');
    }
    // tenants for the membership picker (best effort — page works without)
    try {
      const res = await fetch('/api/tenants', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { tenants?: TenantOption[] } | TenantOption[];
        const list = Array.isArray(body) ? body : (body.tenants ?? []);
        setTenants(list.map((x) => ({ id: x.id, name: x.name })));
      }
    } catch {
      /* tenants are optional for this page */
    }
  }, []);

  useEffect(() => {
    // Deferred one tick: the react-hooks lint forbids synchronous setState
    // inside effects; a light interval keeps lastLoginAt fresh.
    const boot = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), 30000);
    return () => {
      clearTimeout(boot);
      clearInterval(iv);
    };
  }, [load]);

  async function changeRole(u: UserDTO, role: Role): Promise<void> {
    if (role === u.role) return;
    setBusyId(u.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function toggleDisabled(u: UserDTO): Promise<void> {
    if (!u.disabled) {
      setDisableTarget(u);
      return;
    }
    await patchDisabled(u, false);
  }

  async function patchDisabled(u: UserDTO, disabled: boolean): Promise<void> {
    setBusyId(u.id);
    setActionError(null);
    setDisableTarget(null);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function revokeSessions(u: UserDTO): Promise<void> {
    setBusyId(u.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/users/${u.id}/sessions`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function submitReset(): Promise<void> {
    if (!resetTarget) return;
    setResetError(null);
    if (resetPassword.length < 12) {
      setResetError(t('users.err.passwordShort'));
      return;
    }
    setBusyId(resetTarget.id);
    try {
      const res = await fetch(`/api/users/${resetTarget.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: resetPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setResetError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setResetTarget(null);
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function submitDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/users/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? `HTTP ${res.status}`);
      }
      setDeleteTarget(null);
    } finally {
      setBusyId(null);
      await load();
    }
  }

  function toggleMembership(tenantId: string, checked: boolean): void {
    setMemberships((prev) => {
      const next = { ...prev };
      if (checked) next[tenantId] = next[tenantId] ?? 'viewer';
      else delete next[tenantId];
      return next;
    });
  }

  async function submitCreate(): Promise<void> {
    setFormError(null);
    if (form.name.trim().length < 2) {
      setFormError(t('users.err.name'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setFormError(t('users.err.email'));
      return;
    }
    if (form.password.length < 12) {
      setFormError(t('users.err.passwordShort'));
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          locale: form.locale,
          memberships: Object.entries(memberships).map(([tenantId, role]) => ({
            tenantId,
            role,
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setCreateOpen(false);
      setForm(EMPTY_CREATE);
      setMemberships({});
      await load();
    } finally {
      setCreating(false);
    }
  }

  const columns = useMemo<Array<DataTableColumn<UserDTO>>>(
    () => [
      {
        id: 'user',
        header: t('users.col.user'),
        accessor: (u) => `${u.name} ${u.email}`,
        cell: (u) => (
          <div className="min-w-0">
            <div className="truncate text-2 font-medium">{u.name}</div>
            <div className="truncate text-2 text-muted-foreground">{u.email}</div>
          </div>
        ),
      },
      {
        id: 'role',
        header: t('users.col.role'),
        accessor: (u) => u.role,
        cell: (u) => (
          <Badge variant="outline" className={`border ${ROLE_TONE[u.role]}`}>
            {t(`users.role.${u.role}` as TranslationKey)}
          </Badge>
        ),
      },
      {
        id: 'memberships',
        header: t('users.col.memberships'),
        numeric: true,
        accessor: (u) => u.memberships.length,
        cell: (u) =>
          u.memberships.length === 0 ? (
            <span className="text-muted-foreground">{t('users.memberships.none')}</span>
          ) : (
            <span>{u.memberships.length}</span>
          ),
      },
      {
        id: 'locale',
        header: t('users.col.locale'),
        accessor: (u) => (u.locale === 'fa' ? 'فارسی' : 'English'),
        cell: (u) => (u.locale === 'fa' ? 'فارسی' : 'English'),
      },
      {
        id: 'status',
        header: t('users.col.status'),
        accessor: (u) => (u.disabled ? 'disabled' : 'active'),
        cell: (u) =>
          u.disabled ? (
            <Badge variant="outline" className="border-critical/40 bg-critical/10 text-critical">
              {t('users.status.disabled')}
            </Badge>
          ) : (
            <Badge variant="outline" className="border-success/40 bg-success/10 text-success">
              {t('users.status.active')}
            </Badge>
          ),
      },
      {
        id: 'lastLogin',
        header: t('users.col.lastLogin'),
        accessor: (u) => u.lastLoginAt ?? '',
        cell: (u) =>
          u.lastLoginAt ? (
            <span className="whitespace-nowrap">{formatDateTime(u.lastLoginAt)}</span>
          ) : (
            <span className="text-muted-foreground">{t('users.neverLoggedIn')}</span>
          ),
      },
      {
        id: 'actions',
        header: '',
        cell: (u) => {
          const ownerTarget = u.role === 'owner';
          const lastOwnerLocked = ownerTarget && u.disabled === false;
          return (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Select
                value={u.role}
                onValueChange={(v) => void changeRole(u, v as Role)}
                disabled={busyId === u.id || ownerTarget}
              >
                <SelectTrigger
                  className="h-8 w-[8.5rem] text-2"
                  aria-label={`${t('users.a11y.changeRole')}: ${u.name}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GLOBAL_ROLES.filter((r) => r !== 'owner').map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`users.role.${r}` as TranslationKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-2"
                onClick={() => {
                  setResetTarget(u);
                  setResetPassword('');
                  setResetError(null);
                }}
              >
                {t('users.action.resetPassword')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-2"
                disabled={lastOwnerLocked}
                onClick={() => void toggleDisabled(u)}
              >
                {u.disabled ? t('users.action.enable') : t('users.action.disable')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-2"
                onClick={() => void revokeSessions(u)}
              >
                {t('users.action.revokeSessions')}
              </Button>
              {isOwner && !ownerTarget && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border-critical/40 text-critical hover:bg-critical/10"
                  onClick={() => setDeleteTarget(u)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  <span className="sr-only">{t('users.action.delete')}</span>
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [t, busyId, isOwner, users],
  );

  const activeCount = users?.filter((u) => !u.disabled).length ?? 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3 font-semibold tracking-tight">{t('users.title')}</h1>
          <p className="mt-1 text-2 text-muted-foreground">{t('users.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <UserPlus className="size-4" aria-hidden />
          {t('users.action.create')}
        </Button>
      </div>

      {pageError && (
        <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 p-3 text-2 text-critical">
          {t('users.loadError')} ({pageError})
        </p>
      )}
      {actionError && (
        <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 p-3 text-2 text-critical">
          {actionError}
        </p>
      )}

      <div className="flex flex-wrap gap-2 text-2 text-muted-foreground">
        <Badge variant="outline" className="gap-1.5 border-border bg-muted/40 text-2 text-muted-foreground">
          <Users className="size-3.5" aria-hidden />
          {t('users.stat.total', { n: String(users?.length ?? 0) })}
        </Badge>
        <Badge variant="outline" className="gap-1.5 border-success/40 bg-success/10 text-2 text-success">
          <ShieldCheck className="size-3.5" aria-hidden />
          {t('users.stat.active', { n: String(activeCount) })}
        </Badge>
      </div>

      {users === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('users.loading')}
        </div>
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title={t('users.empty.title')} description={t('users.empty.desc')} />
      ) : (
        <DataTable
          columns={columns}
          rows={users}
          rowKey={(u) => u.id}
          ariaLabel={t('users.title')}
          searchAccessor={(u) => `${u.name} ${u.email} ${u.role}`}
          csvFileName="users"
          rowAriaLabel={(u) => `${u.name} (${u.email})`}
        />
      )}

      {/* create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setForm(EMPTY_CREATE);
            setMemberships({});
            setFormError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('users.create.title')}</DialogTitle>
            <DialogDescription>{t('users.create.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="u-name">{t('users.field.name')}</Label>
              <Input
                id="u-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="u-email">{t('users.field.email')}</Label>
              <Input
                id="u-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="u-password">{t('users.field.password')}</Label>
              <Input
                id="u-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password"
              />
              <p className="text-1 text-muted-foreground">{t('users.field.passwordHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="u-role">{t('users.col.role')}</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as Role })}>
                  <SelectTrigger id="u-role" className="text-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GLOBAL_ROLES.filter((r) => (isOwner ? true : r !== 'owner')).map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`users.role.${r}` as TranslationKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="u-locale">{t('users.col.locale')}</Label>
                <Select value={form.locale} onValueChange={(v) => setForm({ ...form, locale: v as 'en' | 'fa' })}>
                  <SelectTrigger id="u-locale" className="text-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="fa">فارسی</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {tenants.length > 0 && (
              <fieldset className="rounded-[4px] border border-border p-3">
                <legend className="px-1 text-2 text-muted-foreground">{t('users.field.memberships')}</legend>
                <div className="max-h-40 space-y-2 overflow-y-auto">
                  {tenants.map((tn) => (
                    <div key={tn.id} className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-2">
                        <Checkbox
                          checked={memberships[tn.id] !== undefined}
                          onCheckedChange={(c) => toggleMembership(tn.id, c === true)}
                          aria-label={`${t('users.field.memberships')}: ${tn.name}`}
                        />
                        <span className="truncate">{tn.name}</span>
                      </label>
                      {memberships[tn.id] !== undefined && (
                        <Select
                          value={memberships[tn.id]}
                          onValueChange={(v) =>
                            setMemberships((prev) => ({
                              ...prev,
                              [tn.id]: v as MembershipDraft[string],
                            }))
                          }
                        >
                          <SelectTrigger className="h-7 w-[8rem] text-1" aria-label={`${tn.name}: ${t('users.col.role')}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MEMBERSHIP_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {t(`users.mrole.${r}` as TranslationKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
            )}
            {formError && (
              <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 p-2 text-2 text-critical">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('users.cancel')}
            </Button>
            <Button onClick={() => void submitCreate()} disabled={creating}>
              {creating && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('users.create.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* password reset dialog */}
      <Dialog
        open={resetTarget !== null}
        onOpenChange={(open) => (open ? null : setResetTarget(null))}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('users.reset.title', { name: resetTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('users.reset.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="u-new-password">{t('users.field.newPassword')}</Label>
            <Input
              id="u-new-password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="text-1 text-muted-foreground">{t('users.field.passwordHint')}</p>
            {resetError && (
              <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 p-2 text-2 text-critical">
                {resetError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              {t('users.cancel')}
            </Button>
            <Button onClick={() => void submitReset()}>{t('users.reset.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* disable confirm — names the account and states the session consequence */}
      <AlertDialog open={disableTarget !== null} onOpenChange={(o) => (o ? null : setDisableTarget(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('users.disable.title', { name: disableTarget?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('users.disable.desc', { email: disableTarget?.email ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('users.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-critical text-critical-foreground hover:bg-critical/90"
              onClick={() => disableTarget && void patchDisabled(disableTarget, true)}
            >
              {t('users.disable.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* delete confirm (owner-only path) */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => (o ? null : setDeleteTarget(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('users.delete.title', { name: deleteTarget?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('users.delete.desc', { email: deleteTarget?.email ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('users.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-critical text-critical-foreground hover:bg-critical/90"
              onClick={() => void submitDelete()}
            >
              {t('users.delete.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
