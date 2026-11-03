# Installing Sentinel-SLA

This guide covers a from-scratch installation on a clean machine (VM or bare
host). The whole procedure is designed around a single command:

```
tar xzf sentinel-sla-2.0.0.tar.gz && cd sentinel-sla-2.0.0 && ./install.sh
```

Target install times: **Demo mode under 5 minutes**, **Live mode under 15
minutes** on a fresh VM. Every path in the scripts is portable — nothing is
hardcoded to a particular machine layout.

## 1. Requirements

| Requirement | Version | Why |
|---|---|---|
| Bun | ≥ 1.3 | JS/TS runtime, package manager, worker process |
| python3 | 3.x with the `sqlite3` stdlib | PDF report pipeline (WeasyPrint) and consistent SQLite backups |
| openssl | any recent | secret generation |
| curl | any recent | health-check waits |

Notes:

- `install.sh` checks all four prerequisites and fails fast with an
  actionable message if one is missing.
- SQLite is the database. PostgreSQL is **not supported yet** (raw SQL uses the
  SQLite dialect); `docker-compose.yml` therefore keeps SQLite on a named volume.
- A firewall opening for the chosen port (default **3000**) is needed for
  users to reach the dashboard.

## 2. The five questions

The installer asks exactly five questions (all are pre-seedable through
environment variables for unattended installs — see §5):

1. **Public base URL** — the domain or IP users will open, e.g.
   `http://10.0.0.5:3000` or `https://sla.example.ir`. Used in notification
   ack links.
2. **Admin e-mail** — you will create the `owner` account with this address at
   first run (`/setup`).
3. **Mode** — `demo` (built-in simulation engine, no external dependencies)
   or `live` (real Prometheus polling; the simulation code path never
   starts).
4. **Prometheus URL** — asked only in live mode, e.g.
   `http://prometheus.internal:9090`. The connection is stored in the
   database (`IntegrationSetting`) and can be edited later in
   **Settings → Integrations**.
5. **Telegram bot token** — optional, Enter to skip. Bale is configured
   later in Settings → Integrations.

## 3. What the installer does

In order, and verbosely logged:

1. Verifies prerequisites (bun ≥ 1.3, python3 + sqlite3, openssl, curl).
2. Asks the five questions.
3. Generates secrets (`SENTINEL_WEBHOOK_BEARER`, `SENTINEL_ACK_SECRET`,
   `SENTINEL_TELEGRAM_WEBHOOK_SECRET`) and writes `.env` with **mode 600**
   (umask 077 during the write). Optional keys that are empty are omitted
   entirely — present-but-empty secrets would fail the config schema.
4. Refuses to overwrite an existing `.env` (an install seems present).
   Override with `SENTINEL_ALLOW_REINSTALL=1` if you really mean it, or use
   `./upgrade.sh` to upgrade in place.
5. `bun install --frozen-lockfile` → `prisma db push` → production build
   (standalone output, self-contained: static assets, public/ and reports/
   are synced into it).
6. Starts the stack — **demo**: one process owns HTTP + engine loops;
   **live**: web + dedicated worker process (the engine runs exactly once).
7. Waits for `/api/health/ready` to report config, database and the report
   pipeline all healthy (up to 180 s), then prints the dashboard URL and the
   first-run link.

## 4. First run

- Open the printed **`/setup`** link. The wizard is only available while the
  database has zero users; it creates the owner account (the admin e-mail
  from question 2) and walks through the initial configuration.
- After setup, sign in at `/login` and invite users in **Settings → Users**
  (roles: `admin`, `engineer`, `executive`, `viewer` — see
  `docs/ADMIN-GUIDE.md`).
- In live mode, verify the Prometheus connection in
  **Settings → Integrations → Test**; the row was seeded by the installer.

## 5. Unattended install (CI / automation)

Every question maps to an environment variable, so a non-interactive install
is fully scriptable:

```
SENTINEL_NONINTERACTIVE=1 \
SENTINEL_MODE=demo \
SENTINEL_PUBLIC_BASE_URL=http://10.0.0.5:3000 \
ADMIN_EMAIL=admin@example.ir \
PORT=3000 \
./install.sh
```

With `SENTINEL_NONINTERACTIVE=1` unanswered questions take their defaults
(and unset optional tokens stay unset). This is exactly how the automated
install test in `deploy/backup-restore-test.sh` boots a scratch instance.

## 6. TLS reverse proxy

The dashboard should be served over TLS in any deployment that is reachable
beyond a trusted network. Run Sentinel-SLA bound to localhost (or a private
interface) and terminate TLS in a reverse proxy. Two supported examples:

### 6.1 Caddy — automatic certificates (internet-connected hosts)

Caddy obtains and renews certificates automatically (ACME / Let's Encrypt).
Use this as `/etc/caddy/Caddyfile`:

```caddy
sla.example.ir {
    reverse_proxy 127.0.0.1:3000
}
```

That is the entire file. Caddy listens on 443, redirects 80 → 443, provisions
the certificate and renewals, and proxies to the app. Ensure DNS for
`sla.example.ir` points at the host and that 80/443 are reachable from the
internet (or from your ACME-visible network for the HTTP-01 challenge).

### 6.2 Nginx — self-signed certificates (offline / air-gapped hosts)

Offline hosts cannot complete an ACME challenge; use a self-signed
certificate (or one issued by your organisation's CA):

```bash
# one-time: self-signed certificate with a SAN (browsers reject CN-only certs)
openssl req -x509 -nodes -newkey rsa:4096 -days 825 \
  -keyout /etc/nginx/ssl/sla.example.ir.key \
  -out    /etc/nginx/ssl/sla.example.ir.crt \
  -subj "/CN=sla.example.ir" \
  -addext "subjectAltName=DNS:sla.example.ir"
```

```nginx
server {
    listen 80;
    server_name sla.example.ir;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name sla.example.ir;

    ssl_certificate     /etc/nginx/ssl/sla.example.ir.crt;
    ssl_certificate_key /etc/nginx/ssl/sla.example.ir.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    }
}
```

Then set `SENTINEL_PUBLIC_BASE_URL=https://sla.example.ir` in `.env` and
restart, so notification ack links carry the external HTTPS URL. Distribute
the self-signed certificate to clients, or import it into their trust store,
to avoid browser warnings.

### 6.3 Kubernetes

The Helm chart ships an ingress template (`ingress.enabled=true`) with
optional TLS blocks; certificate automation is chart-agnostic — pair it with
cert-manager (internet-connected) or a pre-created TLS Secret (offline). See
`deploy/helm/sentinel-sla/values.yaml`.

## 7. Verifying the installation

```
curl -s http://127.0.0.1:3000/api/health/live   # {"ok":true,...}
curl -s http://127.0.0.1:3000/api/health/ready  # config, database, reportPipeline all ok
```

In demo mode the dashboard starts producing simulated incidents within
seconds of first load. In live mode, open an incident by pointing a test
probe at a service (see `docs/USER-GUIDE.md`).

## 8. Known limitations

- Install time: the "fresh VM in under 15 minutes" target has been
  rehearsed with `deploy/backup-restore-test.sh` (which boots a full scratch
  install, runs the engine, backs up, destroys, restores and byte-compares)
  but has not been timed on a freshly provisioned VM.
- Cluster workloads: the Helm chart is linted and template-rendered but has
  not been exercised on a live cluster.
- Single node: the application runs as one active worker; there is no
  high-availability mode.
- Bale tokens are configured through the UI (Settings → Integrations), not
  the installer's five questions.

---

<p dir="rtl" align="right"><sub>نصب باید کسل‌کننده و قابل‌پیش‌بینی باشد. اگر جایی از این راهنما خلاف انتظار پیش رفت، لطفاً یک Issue باز کنید تا مستند اصلاح شود.</sub></p>
