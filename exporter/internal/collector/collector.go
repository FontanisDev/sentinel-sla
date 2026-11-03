// ═══════════════════════════════════════════════════════════════════════════
// Package collector — the heart of Sentinel-SLA's "money bridge".
// Owner: Sentinel-SLA
//
// A custom prometheus.Collector that scrapes the Sentinel-SLA dashboard API
// (GET ${SENTINEL_API_BASE}/api/dashboard, contract in src/lib/types.ts) on
// every Prometheus scrape and re-publishes the data as metrics.
//
// WHY THIS EXISTS: industrial tools (Prometheus/Grafana) speak "technical",
// the CEO speaks "Tomans". This collector is the translator. Each metric's
// business meaning:
//
//   sentinel_service_up{service,tier,criticality}
//       Is the fintech service up (1) or not (0)? Labelled with tier and
//       criticality so alert routing can escalate Tier-1 outages hardest.
//
//   sentinel_service_latency_ms{service}
//       Latest service latency — the pain users feel before an outage.
//
//   sentinel_service_error_rate{service}
//       Fraction of failing requests (0..1). The HighErrorRate alert fires
//       above 5%.
//
//   sentinel_service_throughput{service}
//       Live transactions per second. The height of the cliff when the
//       outage hits.
//
//   sentinel_service_uptime_ratio{service,tenant}
//       Cumulative uptime ratio since engine start. Below 0.999 (the
//       contractual SLA target) the SLABudgetBurn alert fires — this is the
//       number the penalty clause reads.
//
//   sentinel_service_live_up{service,tenant} / sentinel_service_live_stale
//       live-ingestion state from the worker's detection state
//       machine: up=1 after M consecutive good probes, 0 after N failures;
//       stale=1 while Prometheus is unreachable (data missing is NEVER
//       reported as up or down). Omitted when the service has no live probe.
//
//   sentinel_service_sla_target{service}
//       The contractual availability target the penalty clause reads.
//
//   sentinel_tenant_revenue_loss_tomans_total{tenant} /
//   sentinel_tenant_penalty_tomans_total{tenant}
//       per-tenant rollups of the money counters — the "money per
//       service/tenant" view the Contracts & Money dashboard pivots on.
//       Services without a tenant are excluded (fleet totals cover them).
//
//   sentinel_fleet_uptime_ratio, sentinel_sla_compliant_services,
//   sentinel_services_total
//       Fleet-level contractual availability picture from the KPI block.
//
//   sentinel_outbox_depth
//       Notification outbox backlog (pending + delivering). Emitted only
//       when the API reports it — the collector never invents values.
//   sentinel_outbox_dead_total
//       Messages that exhausted their retry budget (dead-letter state).
//
//   sentinel_incident_active{service,severity}
//       Count of ongoing incidents per (service, severity). 0 = healthy.
//
//   sentinel_transactions_lost_total{service}
//       Counter of transactions lost to incidents — aggregated from the
//       incident list the dashboard exposes. Each unit is a customer who
//       could not pay.
//
//   sentinel_revenue_loss_tomans_total{service}
//       Counter of direct revenue loss in Tomans (تومان) — lost transactions
//       valued at average transaction size.
//
//   sentinel_sla_penalty_tomans_total{service}
//       Counter of contractual SLA penalty exposure in Tomans. This is what
//       the executive PDF report quotes to the CEO.
//
//   sentinel_mttd_seconds / sentinel_mttr_seconds
//       Mean Time To Detect / Restore — the chaos-engineering gate lives
//       here (MTTD < 60 s). Emitted only when the API reports them
//       (they are null until the first incident resolves detection).
// ═══════════════════════════════════════════════════════════════════════════
package collector

import (
        "encoding/json"
        "fmt"
        "log"
        "net/http"
        "sync"
        "time"

        "github.com/prometheus/client_golang/prometheus"
)

// ── Minimal projection of the DashboardDTO (src/lib/types.ts) ─────────────
// Unknown fields in the API response are ignored on purpose: the contract is
// additive-only, and a collector must never break the scrape because the
// app grew a new field.

// Service mirrors the fields of ServiceDTO the metrics need.
type Service struct {
        ID                string  `json:"id"`
        Key               string  `json:"key"`
        Name              string  `json:"name"`
        Tier              string  `json:"tier"`
        Criticality       string  `json:"criticality"`
        TenantName        string  `json:"tenantName"` // null in JSON decodes to ""
        LiveStatus        *string `json:"liveStatus"` // up | down | stale | null
        Status            string  `json:"status"`     // up | degraded | down
        LatencyMs         float64 `json:"latencyMs"`
        ErrorRate         float64 `json:"errorRate"`
        Throughput        float64 `json:"throughput"`
        Uptime            float64 `json:"uptime"`
        SlaTarget         float64 `json:"slaTarget"`
        RevenueLossTomans float64 `json:"revenueLossTomans"`
        PenaltyTomans     float64 `json:"penaltyTomans"`
}

// Incident mirrors the fields of IncidentDTO the metrics need.
type Incident struct {
        ServiceID        string  `json:"serviceId"`
        ServiceKey       string  `json:"serviceKey"`
        Status           string  `json:"status"`   // ongoing | resolved
        Severity         string  `json:"severity"` // critical | warning
        LostTransactions float64 `json:"lostTransactions"`
}

// KPIs mirrors KpiDTO. MTTD/MTTR are nullable (null before first incident).
type KPIs struct {
        FleetUptime           float64  `json:"fleetUptime"`
        AvgMttdSec            *float64 `json:"avgMttdSec"`
        AvgMttrSec            *float64 `json:"avgMttrSec"`
        SlaCompliantServices  float64  `json:"slaCompliantServices"`
        TotalServices         float64  `json:"totalServices"`
        OutboxDepth           *float64 `json:"outboxDepth"` // outbox backlog (pending+delivering)
        OutboxDead            *float64 `json:"outboxDead"` // dead-lettered messages
}

// Dashboard is the subset of DashboardDTO we consume.
type Dashboard struct {
        Services  []Service  `json:"services"`
        Incidents []Incident `json:"incidents"`
        KPIs      KPIs       `json:"kpis"`
}

// Collector implements prometheus.Collector (Describe + Collect).
type Collector struct {
        apiBase   string
        client    *http.Client
        authToken string // optional; sent as "Authorization: Bearer" on every fetch

        // metric descriptors
        up           *prometheus.Desc
        latency      *prometheus.Desc
        errorRate    *prometheus.Desc
        throughput   *prometheus.Desc
        uptimeRatio  *prometheus.Desc
        liveUp       *prometheus.Desc
        liveStale    *prometheus.Desc
        slaTarget    *prometheus.Desc
        incident     *prometheus.Desc
        txLost       *prometheus.Desc
        revenueLoss  *prometheus.Desc
        slaPenalty   *prometheus.Desc
        tenantRev    *prometheus.Desc
        tenantPen    *prometheus.Desc
        fleetUptime  *prometheus.Desc
        slaCompliant *prometheus.Desc
        servicesTot  *prometheus.Desc
        outboxDepth  *prometheus.Desc
        outboxDead   *prometheus.Desc
        mttd         *prometheus.Desc
        mttr         *prometheus.Desc

        // last successful snapshot, kept for the executive webhook handler
        mu       sync.RWMutex
        snapshot *Dashboard
}

// SetAuthToken configures the Bearer token sent on every dashboard fetch.
// v2.0.0 protects /api/dashboard (session or API token); the compose stack
// wires SENTINEL_API_TOKEN through. An empty string clears the token.
func (c *Collector) SetAuthToken(token string) {
        c.mu.Lock()
        defer c.mu.Unlock()
        c.authToken = token
}

// New builds a Collector bound to the Sentinel dashboard API base URL.
func New(apiBase string) *Collector {
        const ns = "sentinel"
        serviceLabels := []string{"service"}

        return &Collector{
                apiBase: apiBase,
                client: &http.Client{
                        Timeout: 5 * time.Second, // a scrape must never hang the stack
                },

                up: prometheus.NewDesc(
                        ns+"_service_up",
                        "1 if the fintech service is up, 0 if degraded or down (labels: tier, criticality)",
                        []string{"service", "tier", "criticality"}, nil,
                ),
                latency: prometheus.NewDesc(
                        ns+"_service_latency_ms",
                        "Latest service latency in milliseconds",
                        serviceLabels, nil,
                ),
                errorRate: prometheus.NewDesc(
                        ns+"_service_error_rate",
                        "Fraction of failing requests (0..1); alert above 0.05",
                        serviceLabels, nil,
                ),
                throughput: prometheus.NewDesc(
                        ns+"_service_throughput",
                        "Live throughput in transactions per second",
                        serviceLabels, nil,
                ),
                uptimeRatio: prometheus.NewDesc(
                        ns+"_service_uptime_ratio",
                        "Cumulative uptime ratio since engine start; below the SLA target breaches the budget (labels: service, tenant)",
                        []string{"service", "tenant"}, nil,
                ),
                liveUp: prometheus.NewDesc(
                        ns+"_service_live_up",
                        "1 = live probe up (M consecutive successes), 0 = down (N consecutive failures); omitted without a live probe",
                        []string{"service", "tenant"}, nil,
                ),
                liveStale: prometheus.NewDesc(
                        ns+"_service_live_stale",
                        "1 = Prometheus unreachable for this service (monitoring blind) — never conflated with up or down",
                        []string{"service", "tenant"}, nil,
                ),
                slaTarget: prometheus.NewDesc(
                        ns+"_service_sla_target",
                        "Contractual availability target for the service (0..1)",
                        serviceLabels, nil,
                ),
                incident: prometheus.NewDesc(
                        ns+"_incident_active",
                        "Count of ongoing incidents per service and severity (0 = healthy)",
                        []string{"service", "severity"}, nil,
                ),
                txLost: prometheus.NewDesc(
                        ns+"_transactions_lost_total",
                        "Monotonic counter of transactions lost to incidents (business: one lost card payment)",
                        serviceLabels, nil,
                ),
                revenueLoss: prometheus.NewDesc(
                        ns+"_revenue_loss_tomans_total",
                        "Monotonic counter of direct revenue loss in Tomans (تومان)",
                        serviceLabels, nil,
                ),
                slaPenalty: prometheus.NewDesc(
                        ns+"_sla_penalty_tomans_total",
                        "Monotonic counter of contractual SLA penalty exposure in Tomans (quoted in the executive PDF report)",
                        serviceLabels, nil,
                ),
                tenantRev: prometheus.NewDesc(
                        ns+"_tenant_revenue_loss_tomans_total",
                        "Monotonic counter of revenue loss in Tomans rolled up per tenant (services without a tenant are excluded)",
                        []string{"tenant"}, nil,
                ),
                tenantPen: prometheus.NewDesc(
                        ns+"_tenant_penalty_tomans_total",
                        "Monotonic counter of SLA penalty exposure in Tomans rolled up per tenant",
                        []string{"tenant"}, nil,
                ),
                fleetUptime: prometheus.NewDesc(
                        ns+"_fleet_uptime_ratio",
                        "Fleet-wide cumulative uptime ratio (KPI block)",
                        nil, nil,
                ),
                slaCompliant: prometheus.NewDesc(
                        ns+"_sla_compliant_services",
                        "Number of services currently within their contractual SLA target",
                        nil, nil,
                ),
                servicesTot: prometheus.NewDesc(
                        ns+"_services_total",
                        "Total monitored services",
                        nil, nil,
                ),
                outboxDepth: prometheus.NewDesc(
                        ns+"_outbox_depth",
                        "Notification outbox backlog depth (pending + delivering; emitted only when the API reports it)",
                        nil, nil,
                ),
                outboxDead: prometheus.NewDesc(
                        ns+"_outbox_dead_total",
                        "Messages that exhausted their retry budget and sit in the dead-letter state",
                        nil, nil,
                ),
                mttd: prometheus.NewDesc(
                        ns+"_mttd_seconds",
                        "Mean Time To Detect in seconds (chaos gate: must be < 60s); emitted only when known",
                        nil, nil,
                ),
                mttr: prometheus.NewDesc(
                        ns+"_mttr_seconds",
                        "Mean Time To Restore in seconds; emitted only when known",
                        nil, nil,
                ),
        }
}

// Describe sends all descriptors so Prometheus can validate the collector.
func (c *Collector) Describe(ch chan<- *prometheus.Desc) {
        ch <- c.up
        ch <- c.latency
        ch <- c.errorRate
        ch <- c.throughput
        ch <- c.uptimeRatio
        ch <- c.liveUp
        ch <- c.liveStale
        ch <- c.slaTarget
        ch <- c.incident
        ch <- c.txLost
        ch <- c.revenueLoss
        ch <- c.slaPenalty
        ch <- c.tenantRev
        ch <- c.tenantPen
        ch <- c.fleetUptime
        ch <- c.slaCompliant
        ch <- c.servicesTot
        ch <- c.outboxDepth
        ch <- c.outboxDead
        ch <- c.mttd
        ch <- c.mttr
}

// Collect fetches the dashboard JSON once per scrape and emits the metrics.
func (c *Collector) Collect(ch chan<- prometheus.Metric) {
        dash, err := c.fetch()
        if err != nil {
                // Surface the failure on the scrape itself (standard practice) and
                // log it for operators.
                log.Printf("collector: dashboard fetch failed: %v", err)
                ch <- prometheus.NewInvalidMetric(c.up, fmt.Errorf("dashboard fetch failed: %w", err))
                return
        }

        // keep the snapshot for the executive webhook handler
        c.mu.Lock()
        c.snapshot = dash
        c.mu.Unlock()

        // serviceId → key map (incidents carry both, be tolerant of either)
        idToKey := make(map[string]string, len(dash.Services))
        for _, s := range dash.Services {
                idToKey[s.ID] = s.Key // incidents carry serviceId; the key is our stable label
        }

        // aggregate lost transactions per service from the incident list
        txLostByKey := make(map[string]float64)
        for _, inc := range dash.Incidents {
                key := inc.ServiceKey
                if key == "" {
                        key = idToKey[inc.ServiceID]
                }
                if key != "" {
                        txLostByKey[key] += inc.LostTransactions
                }
        }

        for _, s := range dash.Services {
                // 1 = up, 0 = degraded or down. Degraded nuance is carried by the
                // latency/error-rate metrics instead.
                var up float64
                if s.Status == "up" {
                        up = 1
                }
                ch <- prometheus.MustNewConstMetric(c.up, prometheus.GaugeValue, up,
                        s.Key, s.Tier, s.Criticality)
                ch <- prometheus.MustNewConstMetric(c.latency, prometheus.GaugeValue, s.LatencyMs, s.Key)
                ch <- prometheus.MustNewConstMetric(c.errorRate, prometheus.GaugeValue, s.ErrorRate, s.Key)
                ch <- prometheus.MustNewConstMetric(c.throughput, prometheus.GaugeValue, s.Throughput, s.Key)
                ch <- prometheus.MustNewConstMetric(c.uptimeRatio, prometheus.GaugeValue, s.Uptime, s.Key, s.TenantName)
                ch <- prometheus.MustNewConstMetric(c.slaTarget, prometheus.GaugeValue, s.SlaTarget, s.Key)
                ch <- prometheus.MustNewConstMetric(c.txLost, prometheus.CounterValue, txLostByKey[s.Key], s.Key)
                ch <- prometheus.MustNewConstMetric(c.revenueLoss, prometheus.CounterValue, s.RevenueLossTomans, s.Key)
                ch <- prometheus.MustNewConstMetric(c.slaPenalty, prometheus.CounterValue, s.PenaltyTomans, s.Key)

                // live-ingestion state (omitted when no live probe exists —
                // simulation-only services must not fake a live signal)
                if s.LiveStatus != nil {
                        var lu float64
                        if *s.LiveStatus == "up" {
                                lu = 1
                        }
                        var stale float64
                        if *s.LiveStatus == "stale" {
                                stale = 1
                        }
                        ch <- prometheus.MustNewConstMetric(c.liveUp, prometheus.GaugeValue, lu, s.Key, s.TenantName)
                        ch <- prometheus.MustNewConstMetric(c.liveStale, prometheus.GaugeValue, stale, s.Key, s.TenantName)
                }
        }

        // per-tenant money rollups ("money per service/tenant")
        tenantRev := make(map[string]float64)
        tenantPen := make(map[string]float64)
        for _, s := range dash.Services {
                if s.TenantName == "" {
                        continue
                }
                tenantRev[s.TenantName] += s.RevenueLossTomans
                tenantPen[s.TenantName] += s.PenaltyTomans
        }
        for tn, v := range tenantRev {
                ch <- prometheus.MustNewConstMetric(c.tenantRev, prometheus.CounterValue, v, tn)
        }
        for tn, v := range tenantPen {
                ch <- prometheus.MustNewConstMetric(c.tenantPen, prometheus.CounterValue, v, tn)
        }

        // ongoing incidents per (service, severity) — emit the COUNT so multiple
        // incidents with equal labels never produce duplicate metrics.
        active := make(map[[2]string]float64)
        for _, inc := range dash.Incidents {
                if inc.Status != "ongoing" {
                        continue
                }
                key := inc.ServiceKey
                if key == "" {
                        key = idToKey[inc.ServiceID]
                }
                if key == "" {
                        continue
                }
                active[[2]string{key, inc.Severity}]++
        }
        for pair, count := range active {
                ch <- prometheus.MustNewConstMetric(c.incident, prometheus.GaugeValue, count,
                        pair[0], pair[1])
        }

        // fleet KPIs — only when the API actually knows them (null until the
        // first incident is detected/restored)
        ch <- prometheus.MustNewConstMetric(c.fleetUptime, prometheus.GaugeValue, dash.KPIs.FleetUptime)
        ch <- prometheus.MustNewConstMetric(c.slaCompliant, prometheus.GaugeValue, dash.KPIs.SlaCompliantServices)
        ch <- prometheus.MustNewConstMetric(c.servicesTot, prometheus.GaugeValue, dash.KPIs.TotalServices)
        if dash.KPIs.OutboxDepth != nil {
                ch <- prometheus.MustNewConstMetric(c.outboxDepth, prometheus.GaugeValue, *dash.KPIs.OutboxDepth)
        }
        if dash.KPIs.OutboxDead != nil {
                ch <- prometheus.MustNewConstMetric(c.outboxDead, prometheus.CounterValue, *dash.KPIs.OutboxDead)
        }
        if dash.KPIs.AvgMttdSec != nil {
                ch <- prometheus.MustNewConstMetric(c.mttd, prometheus.GaugeValue, *dash.KPIs.AvgMttdSec)
        }
        if dash.KPIs.AvgMttrSec != nil {
                ch <- prometheus.MustNewConstMetric(c.mttr, prometheus.GaugeValue, *dash.KPIs.AvgMttrSec)
        }
}

// Snapshot returns the last successfully scraped dashboard (may be nil before
// the first successful scrape). Used by the executive-alert webhook handler.
func (c *Collector) Snapshot() *Dashboard {
        c.mu.RLock()
        defer c.mu.RUnlock()
        return c.snapshot
}

// fetch performs GET {apiBase}/api/dashboard with a 5s budget.
func (c *Collector) fetch() (*Dashboard, error) {
        req, err := http.NewRequest(http.MethodGet, c.apiBase+"/api/dashboard", nil)
        if err != nil {
                return nil, fmt.Errorf("build request: %w", err)
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("User-Agent", "sentinel-business-exporter/1.0")
        c.mu.RLock()
        token := c.authToken
        c.mu.RUnlock()
        if token != "" {
                req.Header.Set("Authorization", "Bearer "+token)
        }

        resp, err := c.client.Do(req)
        if err != nil {
                return nil, fmt.Errorf("call dashboard API: %w", err)
        }
        defer resp.Body.Close()

        if resp.StatusCode != http.StatusOK {
                return nil, fmt.Errorf("dashboard API returned HTTP %d", resp.StatusCode)
        }

        var dash Dashboard
        dec := json.NewDecoder(resp.Body)
        if err := dec.Decode(&dash); err != nil {
                return nil, fmt.Errorf("decode dashboard JSON: %w", err)
        }
        return &dash, nil
}
