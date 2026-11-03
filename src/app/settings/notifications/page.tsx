// Legacy /settings/notifications — alerting moved to /alerting/channels
// (alerting IA consolidation). Keep the redirect so old links and the
// SettingsNav history stay valid.
import { redirect } from 'next/navigation';

export default function NotificationsSettingsRedirect() {
  redirect('/alerting/channels');
}
