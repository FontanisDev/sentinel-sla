'use client'

import { useState } from 'react'
import { Building2, CalendarClock, Download, FileDown, FileText, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDateTime, formatFileSize } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { IncidentDTO, ReportDTO, TenantDTO } from '@/lib/types'
import { useGenerateReport, useRegenerateReport } from '@/hooks/use-sentinel'
import { EmptyState } from './empty-state'

type ReportKind = 'executive' | 'statement' | 'incident'
type ReportLang = 'en' | 'fa'

export function ReportsCard({
  reports,
  tenant,
  tenants,
  incidents,
}: {
  reports: ReportDTO[]
  /** Active tenant scope — the default subject for statements. */
  tenant?: TenantDTO | null
  /** All tenants (for the statement subject picker in fleet view). */
  tenants?: TenantDTO[]
  /** Recent incidents (for the incident report subject picker). */
  incidents?: IncidentDTO[]
}) {
  const [kind, setKind] = useState<ReportKind>('executive')
  const [lang, setLang] = useState<ReportLang>('en')
  const [subjectTenant, setSubjectTenant] = useState<string>(tenant?.id ?? '')
  const [incidentId, setIncidentId] = useState<string>('')
  const generate = useGenerateReport()
  const regenerate = useRegenerateReport()
  const { t, name } = useLang()

  const tenantList = tenants ?? (tenant ? [tenant] : [])
  const canGenerate =
    generate.isPending ||
    (kind === 'statement' && !subjectTenant) ||
    (kind === 'incident' && !incidentId)

  const onGenerate = () => {
    generate.mutate({
      kind,
      language: lang,
      ...(kind === 'statement'
        ? { tenantId: subjectTenant }
        : kind === 'incident'
          ? { incidentId }
          : tenant
            ? { tenantId: tenant.id }
            : {}),
    })
  }

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{t('reports.title')}</CardTitle>
        <CardDescription>{t('reports.desc')}</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2 max-sm:col-span-full max-sm:col-start-1 max-sm:row-start-auto max-sm:justify-self-stretch">
          {tenant ? (
            <span
              className="hidden max-w-[170px] items-center gap-1.5 rounded-full border border-ok/25 bg-ok/[0.07] px-2.5 py-1 text-[11px] font-medium text-ok sm:inline-flex"
              title={t('reports.scoped', { name: name(tenant.name, tenant.nameFa) })}
            >
              <Building2 className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{name(tenant.name, tenant.nameFa)}</span>
            </span>
          ) : null}
          {/* template kind (three templates from the same data) */}
          <Select value={kind} onValueChange={(v) => setKind(v as ReportKind)}>
            <SelectTrigger size="sm" className="h-9 w-[150px] max-sm:flex-1 bg-surface-2" aria-label={t('reports.kind')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="executive">{t('reports.kind.executive')}</SelectItem>
              <SelectItem value="statement">{t('reports.kind.statement')}</SelectItem>
              <SelectItem value="incident">{t('reports.kind.incident')}</SelectItem>
            </SelectContent>
          </Select>
          {/* statement subject: tenant picker (fleet view) / fixed when scoped */}
          {kind === 'statement' && !tenant && tenantList.length > 0 ? (
            <Select value={subjectTenant} onValueChange={setSubjectTenant}>
              <SelectTrigger size="sm" className="h-9 w-[170px] max-sm:flex-1 bg-surface-2" aria-label={t('reports.subjectTenant')}>
                <SelectValue placeholder={t('reports.subjectTenant')} />
              </SelectTrigger>
              <SelectContent>
                {tenantList.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {name(c.name, c.nameFa)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {/* incident subject picker */}
          {kind === 'incident' ? (
            <Select value={incidentId} onValueChange={setIncidentId}>
              <SelectTrigger size="sm" className="h-9 w-[200px] max-sm:flex-1 bg-surface-2" aria-label={t('reports.subjectIncident')}>
                <SelectValue placeholder={t('reports.subjectIncident')} />
              </SelectTrigger>
              <SelectContent>
                {(incidents ?? []).map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.serviceName} · {formatDateTime(i.startedAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {/* output language (same data either way) */}
          <Select value={lang} onValueChange={(v) => setLang(v as ReportLang)}>
            <SelectTrigger size="sm" className="h-9 w-[86px] bg-surface-2" aria-label={t('reports.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">{t('reports.lang.en')}</SelectItem>
              <SelectItem value="fa">{t('reports.lang.fa')}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="h-9 gap-1.5 max-sm:flex-1"
            onClick={onGenerate}
            disabled={canGenerate}
            title={kind === 'statement' && !subjectTenant ? t('reports.subjectTenant') : undefined}
          >
            {generate.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileDown className="size-4" aria-hidden="true" />
            )}
            {generate.isPending ? t('reports.generating') : t('reports.generate')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={t('reports.empty.title')}
            description={t('reports.empty.desc')}
            className="py-8"
          />
        ) : (
          <ul
            className="sentinel-scroll-native max-h-96 divide-y divide-white/[0.05] overflow-y-auto pe-1"
            aria-label={t('reports.aria')}
            tabIndex={0}
          >
            {reports.map((r) => (
              <li key={r.id} className="sentinel-row-hover flex items-center gap-3 rounded-lg py-3 first:pt-0 last:pb-0">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                  <FileText className="size-4 text-ok" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{r.fileName}</p>
                  <p className="flex flex-wrap items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                    <span dir="ltr" className="tabular-nums">{formatDateTime(r.generatedAt)} · {formatFileSize(r.fileSize)}</span>
                    <span className="inline-flex items-center rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-1.5 py-px text-[9px] font-medium text-muted-foreground">
                      {t(r.kind === 'statement' ? 'reports.kind.statement' : r.kind === 'incident' ? 'reports.kind.incident' : 'reports.kind.executive')}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-1.5 py-px text-[9px] font-medium text-muted-foreground">
                      {r.language === 'fa' ? t('reports.lang.fa') : t('reports.lang.en')}
                    </span>
                    <span
                      className={
                        r.generatedBy === 'scheduled'
                          ? 'inline-flex items-center gap-1 rounded-full border border-info/25 bg-info/[0.08] px-1.5 py-px text-[9px] font-medium text-info'
                          : 'inline-flex items-center gap-1 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-1.5 py-px text-[9px] font-medium text-muted-foreground'
                      }
                    >
                      {r.generatedBy === 'scheduled' ? (
                        <CalendarClock className="size-2.5" aria-hidden="true" />
                      ) : null}
                      {t(r.generatedBy === 'scheduled' ? 'reports.origin.scheduled' : 'reports.origin.manual')}
                    </span>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => regenerate.mutate(r.id)}
                  disabled={regenerate.isPending && regenerate.variables === r.id}
                  aria-label={t('reports.regenerateAria', { name: r.fileName })}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  {t('reports.regenerate')}
                </Button>
                <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                  <a
                    href={`/api/reports/${encodeURIComponent(r.id)}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('reports.downloadAria', { name: r.fileName })}
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    {t('reports.download')}
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
