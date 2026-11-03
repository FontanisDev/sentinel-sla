'use client'

// Sentinel-SLA — DataTable (design system §6.3, §5 "every list page" rules).
//
// One table engine for the whole product: sticky header, sort, column
// visibility, row selection, density toggle, keyboard navigation, search,
// pagination, CSV export, empty state — RTL-safe via logical properties only
// (ps-/pe-/start-/text-start/text-end). 13px text, 36px rows (28px compact).
//
// Density + visibility + page-size state is per-instance; search focus is
// reachable with "/" (doc §7.8) when the table owns a search box.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Rows3,
  Rows4,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { cn } from '@/lib/utils'
import { formatNumberLocale } from '@/lib/format'
import { useLang } from '@/hooks/use-language'

export type TableDensity = 'default' | 'compact'

export interface DataTableColumn<T> {
  id: string
  header: ReactNode
  /** Value used for sorting AND CSV export (unless `csv` overrides). */
  accessor?: (row: T) => string | number
  /** Numeric sort instead of locale-compare. */
  numeric?: boolean
  cell: (row: T) => ReactNode
  align?: 'start' | 'end'
  /** Column starts hidden (toggleable via the visibility menu). */
  defaultHidden?: boolean
  /** Lock the column out of the visibility menu (e.g. actions). */
  locked?: boolean
  /** Sticky column (typically the first) — survives horizontal scroll. */
  sticky?: boolean
  minWidth?: number
  /** CSV cell override (defaults to `accessor`). */
  csv?: (row: T) => string | number
}

export interface DataTableSelection<T> {
  selectedKeys: ReadonlySet<string>
  onSelectedChange: (keys: string[]) => void
  /** Rows that may not be selected (e.g. ongoing) — checkbox disabled. */
  isDisabled?: (row: T) => boolean
}

interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  ariaLabel: string
  /** Enables the search box; returns the haystack for one row. */
  searchAccessor?: (row: T) => string
  empty?: ReactNode
  minWidth?: number
  maxHeight?: string
  csvFileName?: string
  /** Extra toolbar slot (filters, primary actions). */
  toolbarExtra?: ReactNode
  onRowClick?: (row: T) => void
  rowAriaLabel?: (row: T) => string
  /** Row background tone — avoids ad-hoc bg classes fighting the default. */
  rowTone?: (row: T) => 'default' | 'warn' | 'crit'
  /** Extra non-background classes for rows (shadows, accents). */
  rowClassName?: (row: T) => string | undefined
  initialDensity?: TableDensity
  pageSize?: number
  selectable?: DataTableSelection<T>
  /** Hide the whole toolbar (rare — dialogs). */
  hideToolbar?: boolean
  /** Pre-fills the search box (deep links like /incidents?q=<id>). */
  initialQuery?: string
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// When several DataTables share a page, the FIRST handler to see this keydown
// claims it (the others bail within the same event) — "/" focuses exactly one
// search box (doc §7.8).
let slashClaimedAt = 0

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  ariaLabel,
  searchAccessor,
  empty,
  minWidth,
  maxHeight,
  csvFileName,
  toolbarExtra,
  onRowClick,
  rowAriaLabel,
  rowTone,
  rowClassName,
  initialDensity = 'default',
  pageSize: initialPageSize = 25,
  selectable,
  hideToolbar = false,
  initialQuery,
}: DataTableProps<T>) {
  const { t, lang } = useLang()
  const [query, setQuery] = useState(initialQuery ?? '')
  // Deep links (CommandPalette "?q=") arrive as a server prop; callers key the
  // table on the query to reset state — no effect needed (React docs pattern).
  const [density, setDensity] = useState<TableDensity>(initialDensity)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)),
  )
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(initialPageSize)
  const searchRef = useRef<HTMLInputElement>(null)

  // "/" focuses the table search box (doc §7.8) — skipped while typing.
  useEffect(() => {
    if (!searchAccessor) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      const now = Date.now()
      if (now - slashClaimedAt < 40) return // another table claimed this keypress
      e.preventDefault()
      slashClaimedAt = now
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [searchAccessor])

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hidden.has(c.id)),
    [columns, hidden],
  )

  const filtered = useMemo(() => {
    if (!searchAccessor || query.trim() === '') return rows
    const q = query.trim().toLowerCase()
    return rows.filter((r) => searchAccessor(r).toLowerCase().includes(q))
  }, [rows, query, searchAccessor])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const col = columns.find((c) => c.id === sort.id)
    if (!col?.accessor) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const va = col.accessor!(a)
      const vb = col.accessor!(b)
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb), lang === 'fa' ? 'fa' : 'en') * dir
    })
  }, [filtered, sort, columns, lang])

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = useMemo(
    () => sorted.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [sorted, safePage, pageSize],
  )

  const toggleSort = (col: DataTableColumn<T>) => {
    if (!col.accessor) return
    setSort((prev) =>
      prev?.id === col.id
        ? prev.dir === 'asc'
          ? { id: col.id, dir: 'desc' }
          : null
        : { id: col.id, dir: 'asc' },
    )
  }

  const exportCsv = () => {
    const cols = visibleColumns.filter((c) => c.accessor || c.csv)
    const head = cols.map((c) => c.header).map((h) => csvEscape(String(h)))
    const lines = [head.join(',')]
    for (const r of sorted) {
      lines.push(
        cols
          .map((c) => {
            const raw = c.csv ? c.csv(r) : c.accessor ? c.accessor(r) : ''
            return csvEscape(String(raw))
          })
          .join(','),
      )
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = csvFileName ?? 'sentinel-export.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const dense = density === 'compact'
  const cellPad = dense ? 'px-2 py-1' : 'px-3 py-2'
  const textSize = dense ? 'text-xs' : 'text-[13px]'

  // selection bookkeeping (only when the prop is present)
  const sel = selectable
  const selectableRows = sel ? pageRows.filter((r) => !sel.isDisabled?.(r)) : []
  const allSelected =
    sel !== undefined && selectableRows.length > 0 && selectableRows.every((r) => sel.selectedKeys.has(rowKey(r)))
  const someSelected = sel !== undefined && selectableRows.some((r) => sel.selectedKeys.has(rowKey(r)))

  const toggleAll = () => {
    if (!selectable) return
    if (allSelected) {
      selectable.onSelectedChange(
        [...selectable.selectedKeys].filter(
          (k) => !selectableRows.some((r) => rowKey(r) === k),
        ),
      )
    } else {
      const next = new Set(selectable.selectedKeys)
      for (const r of selectableRows) next.add(rowKey(r))
      selectable.onSelectedChange([...next])
    }
  }

  const handleRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onRowClick(row)
    }
  }

  const ariaSort = (col: DataTableColumn<T>): 'ascending' | 'descending' | 'none' => {
    if (sort?.id !== col.id) return 'none'
    return sort.dir === 'asc' ? 'ascending' : 'descending'
  }

  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      {!hideToolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
          {searchAccessor ? (
            <div className="relative min-w-52 flex-1 sm:max-w-72">
              <Search
                className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-3.5 text-text-3"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(0)
                }}
                placeholder={t('table.search')}
                aria-label={t('table.search')}
                className="h-8 border-line bg-inset ps-8 text-[13px]"
              />
            </div>
          ) : null}

          {toolbarExtra ? <div className="flex items-center gap-2">{toolbarExtra}</div> : null}

          <div className="ms-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-[12px] text-text-2"
                  aria-label={t('table.columns')}
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t('table.columns')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-line bg-surface">
                <DropdownMenuLabel className="text-[11px] text-text-3">
                  {t('table.columns')}
                </DropdownMenuLabel>
                {columns
                  .filter((c) => !c.locked)
                  .map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={!hidden.has(c.id)}
                      onCheckedChange={(checked) =>
                        setHidden((prev) => {
                          const next = new Set(prev)
                          if (checked) next.delete(c.id)
                          else next.add(c.id)
                          return next
                        })
                      }
                      className="text-[13px]"
                    >
                      {c.header}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div
              className="flex items-center rounded-sm border border-line bg-inset p-0.5"
              role="group"
              aria-label={t('table.density')}
            >
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-6 rounded-none',
                  density === 'default' ? 'bg-raised text-text-1' : 'text-text-3',
                )}
                aria-pressed={density === 'default'}
                aria-label={t('table.densityDefault')}
                onClick={() => setDensity('default')}
              >
                <Rows3 className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-6 rounded-none',
                  density === 'compact' ? 'bg-raised text-text-1' : 'text-text-3',
                )}
                aria-pressed={density === 'compact'}
                aria-label={t('table.densityCompact')}
                onClick={() => setDensity('compact')}
              >
                <Rows4 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>

            {csvFileName ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-[12px] text-text-2"
                aria-label={t('table.exportCsv')}
                onClick={exportCsv}
              >
                <Download className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">CSV</span>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {sorted.length === 0 && empty ? (
        empty
      ) : (
        <div
          className={cn('sentinel-scroll-native overflow-x-auto', maxHeight && 'overflow-y-auto')}
          style={maxHeight ? { maxHeight } : undefined}
        >
          <Table
            aria-label={ariaLabel}
            style={minWidth ? { minWidth } : undefined}
            className="border-separate border-spacing-0"
          >
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                {selectable ? (
                  <TableHead
                    className={cn(
                      'sticky top-0 z-20 border-b border-line bg-raised px-2 py-0',
                    )}
                  >
                    <Checkbox
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={toggleAll}
                      aria-label={t('table.selectAll')}
                      className="translate-y-[2px]"
                    />
                  </TableHead>
                ) : null}
                {visibleColumns.map((col) => (
                  <TableHead
                    key={col.id}
                    aria-sort={col.accessor ? ariaSort(col) : undefined}
                    style={col.minWidth ? { minWidth: col.minWidth } : undefined}
                    className={cn(
                      'sticky top-0 z-20 whitespace-nowrap border-b border-line bg-raised font-medium text-text-2',
                      cellPad,
                      textSize,
                      col.align === 'end' ? 'text-end' : 'text-start',
                      col.sticky && 'start-0 z-30',
                    )}
                  >
                    {col.accessor ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col)}
                        className={cn(
                          'inline-flex w-full items-center gap-1 hover:text-text-1',
                          col.align === 'end' ? 'justify-end' : 'justify-start',
                        )}
                        aria-label={t('table.sortBy', { col: String(col.header) })}
                      >
                        {col.header}
                        {sort?.id === col.id ? (
                          sort.dir === 'asc' ? (
                            <ArrowUp className="size-3 text-info" aria-hidden="true" />
                          ) : (
                            <ArrowDown className="size-3 text-info" aria-hidden="true" />
                          )
                        ) : (
                          <ArrowUpDown
                            className="size-3 text-text-3 opacity-60"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => {
                const key = rowKey(row)
                const selected = selectable?.selectedKeys.has(key) ?? false
                const disabled = selectable?.isDisabled?.(row) ?? false
                return (
                  <TableRow
                    key={key}
                    tabIndex={onRowClick ? 0 : undefined}
                    // contrast audit: role="button" on a row containing real
                    // buttons/popovers is a nested-interactive violation —
                    // the row stays keyboard-operable (tabIndex + Enter/Space)
                    // without claiming button semantics.
                    aria-label={rowAriaLabel ? rowAriaLabel(row) : undefined}
                    aria-selected={selectable ? selected : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => handleRowKeyDown(e, row) : undefined}
                    data-state={selected ? 'selected' : undefined}
                    className={cn(
                      'border-b border-line outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-inset',
                      rowTone?.(row) === 'warn' ? 'bg-warn/[0.045]' : undefined,
                      rowTone?.(row) === 'crit' ? 'bg-crit/[0.05]' : undefined,
                      (!rowTone || rowTone?.(row) === 'default') && 'bg-card',
                      dense ? 'h-7' : 'h-9',
                      onRowClick && 'cursor-pointer',
                      rowClassName?.(row),
                    )}
                  >
                    {selectable ? (
                      <TableCell
                        className={cn(
                          'bg-inherit px-2 py-0',
                          dense ? 'h-7' : 'h-9',
                        )}
                      >
                        <Checkbox
                          checked={selected}
                          disabled={disabled}
                          onCheckedChange={(checked) => {
                            const next = new Set(selectable.selectedKeys)
                            if (checked) next.add(key)
                            else next.delete(key)
                            selectable.onSelectedChange([...next])
                          }}
                          aria-label={t('table.selectRow')}
                          className="translate-y-[2px]"
                        />
                      </TableCell>
                    ) : null}
                    {visibleColumns.map((col) => (
                      <TableCell
                        key={col.id}
                        style={col.minWidth ? { minWidth: col.minWidth } : undefined}
                        className={cn(
                          'bg-inherit align-middle',
                          cellPad,
                          textSize,
                          col.align === 'end' ? 'text-end' : 'text-start',
                          col.sticky && 'sticky start-0 z-10 border-e border-line',
                        )}
                      >
                        {col.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {sorted.length > 0 && !hideToolbar ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface px-3 py-2 text-[12px] text-text-2">
          <span dir={lang === 'fa' ? 'rtl' : 'ltr'} className="tabular-nums">
            {t('table.rowsRange', {
              a: formatNumberLocale(safePage * pageSize + 1, lang),
              b: formatNumberLocale(Math.min((safePage + 1) * pageSize, sorted.length), lang),
              n: formatNumberLocale(sorted.length, lang),
            })}
          </span>
          <div className="ms-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="hidden sm:inline">{t('table.pageSize')}</span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v))
                  setPage(0)
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t('table.pageSize')}
                  className="h-7 w-[4.5rem] border-line bg-inset text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-line bg-surface">
                  {[10, 25, 50].map((n) => (
                    <SelectItem key={n} value={String(n)} className="text-[13px]">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-text-2"
                aria-label={t('table.pagePrev')}
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
              </Button>
              <span className="min-w-14 text-center tabular-nums">
                {t('table.pageOf', {
                  a: formatNumberLocale(safePage + 1, lang),
                  n: formatNumberLocale(pageCount, lang),
                })}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-text-2"
                aria-label={t('table.pageNext')}
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
