# Sentinel-SLA — Deployment Runbook (deploy/)

**Stack**: Prometheus + Grafana + Loki + Alertmanager + Blackbox + custom Go exporter.

This directory contains the *industrial* deployment of Sentinel-SLA: official
open-source tools assembled via Docker Compose (and a Helm chart for Kubernetes
under `helm/sentinel-sla/`), with **custom code only** for the business/financial
bridge (`../exporter/`, Go) and the chaos self-test suite (`../chaos/`, Python).

## Bring the stack up

```bash
# 1. The Next.js Sentinel app must already be running on host port 3000
#    (the exporter reads http://host.docker.internal:3000/api/dashboard).

# 2. Validate the configuration (same check CI uses):
bash tests/integration/test_stack.sh

# 3. Start the whole observability stack:
cd deploy/
docker compose up -d
docker compose ps          # wait until everything is healthy/running
docker compose logs -f sentinel-exporter   # the money bridge

# 4. Tear down (data survives in named volumes):
docker compose down
```

**Before first alert delivery**: edit `alertmanager/alertmanager.yml` and replace
`PUT_YOUR_BOT_TOKEN_HERE` / `PUT_CHAT_ID_HERE` with the real Telegram on-call
credentials (create the bot via @BotFather). From inside Iran, route egress to
`api.telegram.org` through the corporate proxy (`HTTPS_PROXY`).

## What each service does

| Service | Role in the Sentinel-SLA pipeline (C4: Collection → Processing → Alerting → Reporting) |
|---|---|
| **prometheus** | Metrics collection + alert rule evaluation (`rules/sentinel-alerts.yml`) — the *Collection* backbone |
| **grafana** | Dashboards — the *technical language* view (engineers); finance panels included |
| **loki** | Log aggregation (TSDB index, local filesystem, 14-day retention) |
| **promtail** | Ships Docker container + `/var/log` logs into Loki (`job=fintech-services`) |
| **alertmanager** | Alert routing: Telegram for engineers; critical alerts **also** hit the exporter webhook for *executive translation* |
| **blackbox-exporter** | HTTP probes of the 6 fintech service health endpoints (`fintech-blackbox` job) |
| **sentinel-exporter** | **Custom Go code**: turns the Sentinel dashboard API into Prometheus metrics (lost transactions, revenue loss & SLA penalties in Tomans) and translates critical Alertmanager webhooks into executive language |

## Ports

| Host port | Service | URL / purpose |
|---:|---|---|
| 3001 | Grafana | http://localhost:3001 — login `admin` / `sentinel-admin` |
| 9090 | Prometheus | http://localhost:9090 — targets, rules, alerts |
| 9093 | Alertmanager | http://localhost:9093 — alert silencing/routing |
| 9108 | Sentinel exporter | http://localhost:9108/metrics · `/webhook/executive-alert` |
| 9115 | Blackbox exporter | http://localhost:9115 — probe endpoint (`/probe`) |
| 3100 | Loki | http://localhost:3100/ready — log store API |
| 3000 | *Next.js app* | not part of this compose — runs on the host |

## Key files

```
deploy/
├── docker-compose.yml              # the assembly (see comments inline)
├── prometheus/prometheus.yml       # scrape jobs incl. fintech-blackbox relabelling
├── prometheus/rules/sentinel-alerts.yml  # bilingual alert rules (ServiceDown, SLABudgetBurn, …)
├── alertmanager/alertmanager.yml   # Telegram + executive webhook routing, inhibition
├── loki/loki-config.yml            # single-node TSDB schema v13, filesystem storage
├── promtail/promtail-config.yml    # docker_sd + varlog → loki:3100
├── blackbox/blackbox.yml           # http_2xx (+ insecure variant for internal PKI)
├── grafana/provisioning/           # datasources (prometheus, loki) + dashboard provider
│   └── dashboards/sentinel-overview.json  # the fleet overview (10 panels + logs)
└── helm/sentinel-sla/              # Kubernetes deployment of the app + exporter sidecar
```

## Operational notes

- **Retention**: metrics 15d (`--storage.tsdb.retention.time`), logs 14d (`limits_config.retention_period`).
- **Volumes**: `prometheus-data`, `grafana-data`, `loki-data` — back them up; they contain the record for SLA penalty claims.
- **Chaos self-test**: run `chaos/auto_chaos.sh` (cron weekly, Sunday 03:00) to validate the MTTD < 60 s target.
- **Kubernetes**: `helm install sentinel deploy/helm/sentinel-sla` — see `helm/sentinel-sla/NOTES.txt`.
- Known limitations: the Helm chart is linted and template-rendered but not cluster-tested; the app runs as a single active worker.
- The six probe targets are `*.example.ir` placeholders — replace with the real fintech endpoints before production.
