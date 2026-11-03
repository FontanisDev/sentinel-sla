'use client'

import { Activity, Flame, Moon, Pause, Play, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { EngineMode, EngineStateDTO } from '@/lib/types'
import { useAutoChaos, useEngineAction } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { LiveClock } from './live-clock'

export function EngineControls({
  engine,
  orientation = 'row',
  className,
}: {
  engine: EngineStateDTO
  orientation?: 'row' | 'col'
  className?: string
}) {
  const engineAction = useEngineAction()
  const autoChaos = useAutoChaos()
  const { t } = useLang()
  const busy = engineAction.isPending || autoChaos.isPending
  const vertical = orientation === 'col'

  return (
    <div
      className={cn(
        'flex items-center gap-2',
        vertical && 'flex-col items-stretch gap-3',
        className
      )}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={engine.mode}
        onValueChange={(v) => {
          if (v && !busy) engineAction.mutate({ action: 'set-mode', mode: v as EngineMode })
        }}
        aria-label={t('engine.mode.label')}
        disabled={busy}
        className={cn('bg-surface-2', vertical && 'w-full')}
      >
        <ToggleGroupItem value="calm" aria-label={t('engine.mode.calm')} className="gap-1.5 flex-1">
          <Moon className="size-3.5" aria-hidden="true" />
          {vertical ? <span className="text-xs">{t('engine.mode.calm')}</span> : null}
        </ToggleGroupItem>
        <ToggleGroupItem value="normal" aria-label={t('engine.mode.normal')} className="gap-1.5 flex-1">
          <Activity className="size-3.5" aria-hidden="true" />
          {vertical ? <span className="text-xs">{t('engine.mode.normal')}</span> : null}
        </ToggleGroupItem>
        <ToggleGroupItem value="storm" aria-label={t('engine.mode.storm')} className="gap-1.5 flex-1">
          <Zap className="size-3.5" aria-hidden="true" />
          {vertical ? <span className="text-xs">{t('engine.mode.storm')}</span> : null}
        </ToggleGroupItem>
      </ToggleGroup>

      <Button
        variant="outline"
        size="icon"
        className={cn('size-8 shrink-0', vertical && 'h-9 w-full')}
        onClick={() => engineAction.mutate({ action: engine.running ? 'pause' : 'resume' })}
        aria-label={engine.running ? t('engine.pause') : t('engine.resume')}
        disabled={busy}
      >
        {engine.running ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'flex h-8 shrink-0 items-center gap-2 rounded-md border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-2.5',
              vertical && 'h-9 w-full justify-between px-3'
            )}
          >
            <span className="flex items-center gap-1.5">
              <Flame
                className={cn('size-3.5', engine.autoChaos ? 'text-warn' : 'text-muted-foreground')}
                aria-hidden="true"
              />
              {vertical ? (
                <span className="text-xs font-medium">{t('engine.autoChaos')}</span>
              ) : (
                <span className="sr-only">{t('engine.autoChaos')}</span>
              )}
            </span>
            <Switch
              checked={engine.autoChaos}
              onCheckedChange={(checked) => autoChaos.mutate({ enabled: checked })}
              aria-label={t('engine.autoChaosToggle')}
              disabled={busy}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('engine.autoChaosTooltip')}</TooltipContent>
      </Tooltip>

      {vertical ? (
        <LiveClock className="flex h-9 items-center justify-center rounded-md border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-3 font-mono text-xs text-muted-foreground" />
      ) : null}
    </div>
  )
}

export function HeaderClock() {
  return (
    <LiveClock className="hidden h-8 items-center rounded-md border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-2.5 font-mono text-xs text-muted-foreground lg:flex" />
  )
}
