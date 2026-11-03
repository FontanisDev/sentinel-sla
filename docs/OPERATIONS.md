# Operating Sentinel-SLA

Day-2 operations: backups, restore, upgrades, logs, and troubleshooting.
Everything here uses the shipped scripts and real commands — no steps are
left as an exercise. All scripts live in `deploy/` with thin entrypoints at
the repository root (`./backup.sh`, `./restore.sh`, `./upgrade.sh`).

## 1. Backups

```
./backup.sh
```

What one run produces (a timestamped tarball under `backups/`):

- **Database** — a *consistent* snapshot. SQLite is backed up through the
  python3 standard-library backup API (a page-consistent copy taken while
  the engine keeps running — no server stop, no `sqlite3` CLI dependency).
  (A `pg_dump` branch exists for a future Postgres port; Postgres is not
  supported today.)
- **Data directory** — archived PDF reports and engine artefacts
  (`SENTINEL_DATA_DIR`, default `data/`).
- **Configuration** — the `.env` file (which contains the generated
  secrets — store backups accordingly, mode 600 is preserved).
- **Manifest + `SHA256SUMS`** — every entry is checksummed so `restore.sh`
  can verify integrity *before* touching anything.

Backup cadence guidance: nightly `./backup.sh` from cron plus a manual run
before every `./upgrade.sh` (upgrade does this automatically as its first
step anyway). Keep at least the last N=7 backups off the host.

> **Secret handling**: a backup tarball contains `.env` (bearer tokens, ack
> secret, database URL). Treat every backup as a credential — the tarball is
> written mode 600 and should be moved to encrypted storage.

## 2. Restore

```
./restore.sh backups/sentinel-2026-10-08T120000.tar.gz          # clean target
./restore.sh backups/sentinel-2026-10-08T120000.tar.gz --force  # overwrite non-clean target
```

Safety model, in order:

1. **Verify first**: every `SHA256SUMS` entry in the tarball is checked
   *before anything on the target is modified*. A tampered or truncated
   backup aborts here.
2. **Clean-target guard**: if the target database, `.env` or data artefacts
   already exist, the restore refuses without `--force`. The flag is your
   explicit acknowledgement that current state will be replaced.
3. Restore database + data dir + `.env` (`.env` back to mode 600), then the
   stack can be started normally.

The restore path is exercised end-to-end by
`deploy/backup-restore-test.sh`: it seeds a deterministic tenant, runs the
engine, snapshots 24 table counts + `.env` hash + data manifest, backs up,
**destroys** the database/config/data, restores, snapshots again and
byte-compares the two snapshots — the numbers after a restore are identical
by construction (the test proves it on every run).

## 3. Upgrades

```
./upgrade.sh
```

Sequence, and the failure behaviour:

1. **Backup first** — the pre-upgrade backup is the rollback anchor.
2. Dependencies (`bun install --frozen-lockfile`) and schema
   (`prisma db push`).
3. Rebuild the standalone production bundle.
4. Restart the stack and wait for `/api/health/ready`.
5. **On any failure at any step**: the pre-upgrade backup is restored
   automatically and the previous version is restarted. You end either on a
   healthy new version or on a healthy old version — never in between.

Version in flight: `package.json` (`version`), the Helm chart
(`Chart.yaml`: `version` + `appVersion`), and `CHANGELOG.md` must agree on
`2.0.0`.

## 4. Logs

| What | Where / command |
|---|---|
| Dev server | `dev.log` (repo root, dev mode) |
| Production server | `server.log` (repo root; `npm start` tees stdout) |
| Engine lifecycle | lines prefixed `[sentinel]` (engine start, mode, reconciles) |
| Outbox dispatcher | `[sentinel:outbox]` |
| Digest / self-test schedulers | `[sentinel:digest]`, `[sentinel:selftest]` |
| Request log | structured Next.js request lines (`GET /api/... 200`) |

Health endpoints for probes and dashboards:

- `GET /api/health/live` — process up; cheap and always public.
- `GET /api/health/ready` — config valid, database answers, report pipeline
  (WeasyPrint script + fonts) present. Use this one for restart decisions.

## 5. Diagnostic bundle (sentinel-doctor)

For remote help, run the doctor and attach its bundle to the support request —
it is redacted by construction (no `.env` values, no tokens, no database rows —
counts and health only):

```bash
./doctor.sh                    # or: ./deploy/doctor.sh, PORT=3000 by default
# → doctor/sentinel-doctor-<timestamp>.txt  (path + sha256 printed)
```

The bundle contains: host/OS/tool versions, which `.env` KEYS are set (names
only, plus the non-secret `SENTINEL_MODE`/`SENTINEL_ROLE`/`PORT` values and the
database ENGINE), process liveness (web/worker pids, port probe), verbatim
`/api/health/live` + `/api/health/ready` responses, the last 40 `[sentinel]`
engine log lines, per-table aggregate counts (incidents open, outbox
pending/dead — status names mirror `src/server/notify/outbox.ts`), backup
directory listing (names only) and disk usage. Never attach `.env`, the
database or report PDFs instead — see `docs/SUPPORT.md` §4.

## 6. Troubleshooting

**Engine not ticking / no live incidents in demo mode**
Look for `[sentinel] engine started — N services, 2500ms tick` at process
start. If absent, check `SENTINEL_ROLE` — a `web`-roled process does not own
the loops by design; the worker process does (live mode runs both).

**`/api/health/ready` says reportPipeline not ok**
The report service needs the WeasyPrint script and its fonts. In a
standalone deployment the build copies `reports/` next to the server; if the
directory was removed, re-run the build (or restore from backup). The config
log line names the pipeline of record (`reportWeasyScript`).

**Login immediately locked out**
Five failed attempts lock the account for 15 minutes (deliberate, rate
limiter + lockout). An admin can clear state in Settings → Users; otherwise
wait out the window.

**Notifications not arriving**
Check the transport mode (`SENTINEL_NOTIFY_TRANSPORT=auto` delivers for real
only when a channel is configured; `simulate` never sends), the bot token in
`.env` or Settings → Integrations, and the outbox log lines
(`[sentinel:outbox]`) for delivery failures.

**Database URL surprise after switching shells**
`deploy/lib.sh` deliberately takes `DATABASE_URL` from the install's own
`.env` even if the ambient shell exports another value — this protects
`prisma db push` from being aimed at a foreign database. If you manage the
variable by hand anyway, `source .env` first.

**Port already in use**
Set `PORT` in `.env` (or `PORT=3100 ./install.sh` on first install). The
health wait prints the URL it is actually polling.

**Disc-space creep from report archives**
Archived PDFs accumulate under `SENTINEL_DATA_DIR/reports`. The archive is
part of backups by design; if you prune manually, run `./backup.sh` right
after so the manifest stays truthful.

---

<p dir="rtl" align="right"><sub>سامانه‌ای که پشتیبان‌گیری‌اش را هرگز بازیابی نکرده‌اید، پشتیبان ندارد. بازیابی را تمرین کنید.</sub></p>
