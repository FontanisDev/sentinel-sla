// GET /api/notifications/templates — message-template catalog with sample
// renders for the settings UI ("templates … with variables,
// preview in the UI").
//
//   200 → { transport, ackConfigured, templates: [{ topic, severity,
//           technical: {title, body}, executive: {title, body}, sampleVars }] }
//
// Engineer floor (ops read). Sample vars are clearly-labelled demo data —
// never live product numbers.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { requireRole, requireUser } from '@/server/authz';
import { getEngine } from '@/server/engine';
import { resolveNotifySettings } from '@/server/notify/outbox';
import { renderNotification, sampleVars, TEMPLATE_CATALOG } from '@/server/notify/templates';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz: telemetry read, all roles
    await getEngine().ensureInit();
    const settings = await resolveNotifySettings();
    const templates = TEMPLATE_CATALOG.map(({ topic, severity }) => {
      const vars = sampleVars(topic, severity);
      return {
        topic,
        severity,
        technical: renderNotification(topic, severity, 'technical', vars),
        executive: renderNotification(topic, severity, 'executive', vars),
        sampleVars: vars,
      };
    });
    return NextResponse.json({
      transport: settings.transport,
      ackConfigured: settings.ackSecret !== null,
      templates,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
