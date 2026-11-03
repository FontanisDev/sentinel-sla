'use client';

// /alerting/channels client body — AlertingPage shell around the extracted
// NotificationsBody (channels + delivery log + outbox + digest).

import { useLang } from '@/hooks/use-language';
import { AlertingPage } from './alerting-page';
import { NotificationsBody } from './notifications-parts';

export function ChannelsClient({
  user,
}: {
  user: { name: string; email: string; role: string; locale?: string | null };
}) {
  const { t } = useLang();
  return (
    <AlertingPage active="channels" user={user} title={t('alerting.channels.title')} description={t('alerting.channels.desc')}>
      <NotificationsBody />
    </AlertingPage>
  );
}
