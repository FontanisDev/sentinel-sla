// POST /api/engine — pause | resume | set-mode simulation control.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { engineActionSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = engineActionSchema.parse(await readJsonBody(req));
    const engine = getEngine();
    switch (parsed.action) {
      case 'pause':
        engine.pause();
        break;
      case 'resume':
        engine.resume();
        break;
      case 'set-mode':
        if (!parsed.mode) {
          throw new HttpError(400, "mode is required for action 'set-mode'");
        }
        engine.setMode(parsed.mode);
        break;
    }
    return NextResponse.json({ ok: true, engine: engine.getEngineState() });
  } catch (err) {
    return toErrorResponse(err);
  }
}
