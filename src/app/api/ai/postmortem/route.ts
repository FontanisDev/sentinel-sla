// POST /api/ai/postmortem — LLM-generated incident post-mortem.
//
// Uses an optional OpenAI-compatible endpoint (backend only) to turn a raw incident record into a
// structured post-mortem that serves both audiences of Sentinel-SLA:
// an executive impact statement (Tomans) and an engineering-focused root-cause
// hypothesis with recommendations. The result is persisted on the incident.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { readJsonBody, toErrorResponse, HttpError } from '@/server/http'
import { buildHeuristicPostMortem, type PostMortemSource } from '@/server/postmortem';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({
  incidentId: z.string().min(1).max(64),
});

function fmtT(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B Tomans`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M Tomans`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K Tomans`;
  return `${Math.round(v)} Tomans`;
}

function fmtSec(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'n/a';
  if (v < 60) return `${Math.round(v)}s`;
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const { incidentId } = schema.parse(await readJsonBody(req));

    const incident = await db.incident.findUnique({
      where: { id: incidentId },
      include: { service: true },
    });
    if (!incident) throw new HttpError(404, 'Incident not found');

    const svc = incident.service;

    const facts = [
      `Service: ${svc.name} (${svc.key}), tier ${svc.tier}, criticality ${svc.criticality}`,
      `Endpoint: ${svc.endpoint}`,
      `Baseline: ${svc.baseLatencyMs}ms latency, ${svc.tps} tx/s, avg transaction ${fmtT(svc.avgTransactionValue)}`,
      `SLA target: ${(svc.slaTarget * 100).toFixed(3)}%`,
      `Incident severity: ${incident.severity}, source: ${incident.source}, status: ${incident.status}`,
      `Fault started: ${incident.startedAt.toISOString()}`,
      incident.detectedAt ? `Detected: ${incident.detectedAt.toISOString()} (MTTD ${fmtSec(incident.mttdSec)})` : 'Not yet detected at generation time',
      incident.resolvedAt ? `Resolved: ${incident.resolvedAt.toISOString()} (MTTR ${fmtSec(incident.mttrSec)})` : 'Still ongoing',
      `Financial impact: ${incident.lostTransactions} lost transactions, ${fmtT(incident.revenueLossTomans)} revenue loss, ${fmtT(incident.penaltyTomans)} contractual SLA penalty`,
    ].join('\n');

    const systemPrompt =
      'You are the principal SRE of an Iranian fintech company. You write incident ' +
      'post-mortems for Sentinel-SLA, a monitoring product whose key promise is ' +
      'speaking two languages: precise engineering language for the DevOps team, and ' +
      'financial language (Tomans) for the CEO. Be factual — only use the numbers ' +
      'provided, never invent data. Be concise and concrete.';

    const userPrompt =
      `Write a post-mortem for the incident below. Structure it EXACTLY as:\n\n` +
      `EXECUTIVE SUMMARY\n<2-3 sentences for the CEO: what happened, business cost in ` +
      `Tomans, whether the 60-second contractual detection gate (MTTD) was met.>\n\n` +
      `TECHNICAL ASSESSMENT\n<3-5 sentences: likely root-cause hypotheses for this fault ` +
      `type, what the detection pipeline observed, quality of the response timing.>\n\n` +
      `RECOMMENDATIONS\n<2-4 bullet points, each actionable and specific to this service.>\n\n` +
      `Keep total length under 320 words. Plain text, no markdown headers, use the ` +
      `exact section titles above.\n\nINCIDENT RECORD:\n${facts}`;

    let summary: string
    let source: PostMortemSource
    try {
      // Optional OpenAI-compatible backend (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).
      // When unset or unreachable we fall back to the rule-based generator below.
      const baseUrl = process.env.LLM_BASE_URL?.trim()
      const model = process.env.LLM_MODEL?.trim()
      if (!baseUrl || !model) throw new Error('LLM_BASE_URL / LLM_MODEL not configured')
      const apiKey = process.env.LLM_API_KEY?.trim()
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`LLM backend answered HTTP ${res.status}`)
      const completion = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const llmSummary = completion.choices?.[0]?.message?.content?.trim()
      if (!llmSummary) throw new HttpError(502, 'AI post-mortem generation returned empty content')
      summary = llmSummary
      source = 'llm'
    } catch (llmErr) {
      // Graceful degradation: the AI backend being unreachable must never take
      // the post-mortem promise down with it. Fall back to the deterministic
      // rule-based generator and label the artifact honestly.
      console.warn(
        `[sentinel:ai] LLM backend unavailable (${(llmErr as Error).message?.slice(0, 140) ?? 'unknown error'}) — ` +
          `falling back to rule-based post-mortem for incident ${incidentId.slice(-6)}`,
      )
      summary = buildHeuristicPostMortem(incident, svc)
      source = 'heuristic'
    }

    const updated = await db.incident.update({
      where: { id: incidentId },
      data: { aiSummary: summary, aiSource: source, aiGeneratedAt: new Date() },
    })

    console.log(`[sentinel:ai] post-mortem generated for incident ${incidentId.slice(-6)} (source: ${source})`)
    return NextResponse.json({
      summary: updated.aiSummary,
      generatedAt: updated.aiGeneratedAt?.toISOString() ?? new Date().toISOString(),
      source,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
