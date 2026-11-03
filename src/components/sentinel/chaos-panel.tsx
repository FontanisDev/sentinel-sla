'use client'

import { useMemo, useState } from 'react'
import { Bug, Check, FlaskConical, Gauge, Loader2, X, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { formatDateTime, formatDuration } from '@/lib/format'
import type { ChaosExperimentDTO, ChaosType, ServiceDTO } from '@/lib/types'
import { useLaunchChaos } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { CHAOS_STATUS, CHAOS_TYPE_LABEL } from './status'
import { EmptyState } from './empty-state'

const CHAOS_TYPE_ICON: Record<ChaosType, typeof Zap> = {
  outage: Zap,
  latency: Gauge,
  'error-spike': Bug,
}

const DURATIONS = ['15', '45', '90'] as const

export function ChaosPanel({ services, experiments }: { services: ServiceDTO[]; experiments: ChaosExperimentDTO[] }) {
  const [serviceId, setServiceId] = useState('')
  const [type, setType] = useState<ChaosType>('outage')
  const [durationSec, setDurationSec] = useState('45')
  const chaos = useLaunchChaos()
  const { t, name } = useLang()

  const effectiveServiceId = useMemo(
    () => (services.find((s) => s.id === serviceId)?.id ?? services[0]?.id ?? ''),
    [services, serviceId]
  )
  const selectedService = services.find((s) => s.id === effectiveServiceId)
  const TypeIcon = CHAOS_TYPE_ICON[type]

  const launch = () => {
    if (!effectiveServiceId) return
    chaos.mutate({ serviceId: effectiveServiceId, type, durationSec: Number(durationSec) })
  }

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-warn" aria-hidden="true" />
          {t('chaos.title')}
        </CardTitle>
        <CardDescription>{t('chaos.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Quick launch */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="chaos-service" className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('chaos.target')}
            </label>
            <Select value={effectiveServiceId} onValueChange={setServiceId}>
              <SelectTrigger id="chaos-service" size="sm" className="h-9 w-full bg-surface-2">
                <SelectValue placeholder={t('chaos.selectService')} />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {name(s.name, s.nameFa)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1.5">
            <label htmlFor="chaos-type" className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('chaos.experiment')}
            </label>
            <Select value={type} onValueChange={(v) => setType(v as ChaosType)}>
              <SelectTrigger id="chaos-type" size="sm" className="h-9 w-full bg-surface-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CHAOS_TYPE_LABEL) as ChaosType[]).map((ty) => {
                  const Icon = CHAOS_TYPE_ICON[ty]
                  return (
                    <SelectItem key={ty} value={ty}>
                      <Icon className="size-3.5" aria-hidden="true" />
                      {t(CHAOS_TYPE_LABEL[ty])}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1.5 sm:max-w-[150px]">
            <label htmlFor="chaos-duration" className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('chaos.duration')}
            </label>
            <Select value={durationSec} onValueChange={setDurationSec}>
              <SelectTrigger id="chaos-duration" size="sm" className="h-9 w-full bg-surface-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {t('chaos.seconds', { n: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="h-9 gap-1.5 sm:h-9 sm:self-end"
                disabled={!effectiveServiceId || chaos.isPending}
              >
                {chaos.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <TypeIcon className="size-4" aria-hidden="true" />
                )}
                {t('chaos.launch')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('chaos.confirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('chaos.confirmDesc', {
                    service: selectedService ? name(selectedService.name, selectedService.nameFa) : t('chaos.target'),
                    type: t(CHAOS_TYPE_LABEL[type]),
                    dur: durationSec,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('chaos.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={launch}>{t('chaos.launch')}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* History */}
        {experiments.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title={t('chaos.empty.title')}
            description={t('chaos.empty.desc')}
            className="py-6"
          />
        ) : (
          <div className="sentinel-scroll-native overflow-x-auto rounded-[6px] border ">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="ps-4">{t('table.service')}</TableHead>
                  <TableHead>{t('chaos.experiment')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead className="text-end">{t('itable.mttd')}</TableHead>
                  <TableHead className="text-end">{t('itable.mttr')}</TableHead>
                  <TableHead className="pe-4 text-end">{t('chaos.started')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {experiments.map((exp) => {
                  const st = CHAOS_STATUS[exp.status]
                  const Icon = CHAOS_TYPE_ICON[exp.type]
                  return (
                    <TableRow key={exp.id} className="border-black/[0.05] dark:border-white/[0.05]">
                      <TableCell className="ps-4 text-xs font-medium">{exp.serviceName}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="gap-1 border-line bg-raised text-[10px] text-muted-foreground">
                          <Icon className="size-3" aria-hidden="true" />
                          {t(CHAOS_TYPE_LABEL[exp.type])}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn('gap-1 text-[10px]', st.chip)}>
                          {st.pulse ? (
                            <span className="size-1.5 animate-status-pulse rounded-full bg-warn" aria-hidden="true" />
                          ) : null}
                          {t(st.label)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">
                        <span className="inline-flex items-center justify-end gap-1 text-xs tabular-nums">
                          {formatDuration(exp.mttdSec)}
                          {exp.gatePassed === true ? (
                            <Check className="size-3.5 text-ok" aria-label={t('chaos.gatePassed')} />
                          ) : exp.gatePassed === false ? (
                            <X className="size-3.5 text-crit" aria-label={t('chaos.gateFailed')} />
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-end text-xs tabular-nums">
                        {formatDuration(exp.mttrSec)}
                      </TableCell>
                      <TableCell className="pe-4 text-end text-[11px] tabular-nums text-muted-foreground">
                        {formatDateTime(exp.startedAt)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
