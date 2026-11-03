package collector

// Unit tests for the metrics mapping.
//
// The mapping is exercised against a fixture dashboard JSON served by
// httptest — the same envelope the real /api/dashboard produces
// (additive-only contract: unknown fields are ignored).
//
// Run: cd exporter && go test ./...

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// fixture: two services (one tenant-bound with a live probe, one fleet-wide
// without), one ongoing incident, full KPI block with outbox depth present.
const fixtureDashboard = `{
  "services": [
    {
      "id": "svc-1", "key": "payments-api", "name": "Payments API",
      "tier": "tier-1", "criticality": "critical",
      "tenantId": "t-1", "tenantName": "Digikala",
      "liveStatus": "down",
      "status": "down", "latencyMs": 812.4, "errorRate": 0.61, "throughput": 0.2,
      "tps": 40, "avgTransactionValue": 300000, "slaTarget": 0.9995,
      "uptime": 0.9971, "incidentsCount": 2,
      "revenueLossTomans": 240000000, "penaltyTomans": 22500000,
      "series": {"ts": [], "latencyMs": [], "errorRate": [], "throughput": [], "status": []}
    },
    {
      "id": "svc-2", "key": "ledger-api", "name": "Ledger API",
      "tier": "tier-2", "criticality": "high",
      "tenantId": null, "tenantName": null,
      "liveStatus": null,
      "status": "up", "latencyMs": 96.5, "errorRate": 0.002, "throughput": 88.1,
      "tps": 90, "avgTransactionValue": 200000, "slaTarget": 0.999,
      "uptime": 0.9999, "incidentsCount": 0,
      "revenueLossTomans": 0, "penaltyTomans": 0,
      "series": {"ts": [], "latencyMs": [], "errorRate": [], "throughput": [], "status": []}
    }
  ],
  "incidents": [
    {
      "id": "inc-1", "serviceId": "svc-1", "serviceKey": "payments-api",
      "status": "ongoing", "severity": "critical", "lostTransactions": 310
    }
  ],
  "kpis": {
    "fleetUptime": 0.9985,
    "avgMttdSec": 12.5,
    "avgMttrSec": 480,
    "slaCompliantServices": 1,
    "totalServices": 2,
    "outboxDepth": 3,
    "outboxDead": 1
  }
}`

func newFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fixtureDashboard))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestMetricsMapping(t *testing.T) {
	c := New(newFixtureServer(t).URL)
	reg := prometheus.NewPedanticRegistry()
	if err := reg.Register(c); err != nil {
		t.Fatalf("register collector: %v", err)
	}

	expected := `
# HELP sentinel_service_up 1 if the fintech service is up, 0 if degraded or down (labels: tier, criticality)
# TYPE sentinel_service_up gauge
sentinel_service_up{criticality="critical",service="payments-api",tier="tier-1"} 0
sentinel_service_up{criticality="high",service="ledger-api",tier="tier-2"} 1
# HELP sentinel_service_uptime_ratio Cumulative uptime ratio since engine start; below the SLA target breaches the budget (labels: service, tenant)
# TYPE sentinel_service_uptime_ratio gauge
sentinel_service_uptime_ratio{service="payments-api",tenant="Digikala"} 0.9971
sentinel_service_uptime_ratio{service="ledger-api",tenant=""} 0.9999
# HELP sentinel_service_sla_target Contractual availability target for the service (0..1)
# TYPE sentinel_service_sla_target gauge
sentinel_service_sla_target{service="payments-api"} 0.9995
sentinel_service_sla_target{service="ledger-api"} 0.999
# HELP sentinel_service_live_up 1 = live probe up (M consecutive successes), 0 = down (N consecutive failures); omitted without a live probe
# TYPE sentinel_service_live_up gauge
sentinel_service_live_up{service="payments-api",tenant="Digikala"} 0
# HELP sentinel_service_live_stale 1 = Prometheus unreachable for this service (monitoring blind) — never conflated with up or down
# TYPE sentinel_service_live_stale gauge
sentinel_service_live_stale{service="payments-api",tenant="Digikala"} 0
# HELP sentinel_transactions_lost_total Monotonic counter of transactions lost to incidents (business: one lost card payment)
# TYPE sentinel_transactions_lost_total counter
sentinel_transactions_lost_total{service="payments-api"} 310
sentinel_transactions_lost_total{service="ledger-api"} 0
# HELP sentinel_revenue_loss_tomans_total Monotonic counter of direct revenue loss in Tomans (تومان)
# TYPE sentinel_revenue_loss_tomans_total counter
sentinel_revenue_loss_tomans_total{service="payments-api"} 2.4e+08
sentinel_revenue_loss_tomans_total{service="ledger-api"} 0
# HELP sentinel_sla_penalty_tomans_total Monotonic counter of contractual SLA penalty exposure in Tomans (quoted in the executive PDF report)
# TYPE sentinel_sla_penalty_tomans_total counter
sentinel_sla_penalty_tomans_total{service="payments-api"} 2.25e+07
sentinel_sla_penalty_tomans_total{service="ledger-api"} 0
# HELP sentinel_tenant_revenue_loss_tomans_total Monotonic counter of revenue loss in Tomans rolled up per tenant (services without a tenant are excluded)
# TYPE sentinel_tenant_revenue_loss_tomans_total counter
sentinel_tenant_revenue_loss_tomans_total{tenant="Digikala"} 2.4e+08
# HELP sentinel_tenant_penalty_tomans_total Monotonic counter of SLA penalty exposure in Tomans rolled up per tenant
# TYPE sentinel_tenant_penalty_tomans_total counter
sentinel_tenant_penalty_tomans_total{tenant="Digikala"} 2.25e+07
# HELP sentinel_fleet_uptime_ratio Fleet-wide cumulative uptime ratio (KPI block)
# TYPE sentinel_fleet_uptime_ratio gauge
sentinel_fleet_uptime_ratio 0.9985
# HELP sentinel_sla_compliant_services Number of services currently within their contractual SLA target
# TYPE sentinel_sla_compliant_services gauge
sentinel_sla_compliant_services 1
# HELP sentinel_services_total Total monitored services
# TYPE sentinel_services_total gauge
sentinel_services_total 2
# HELP sentinel_outbox_depth Notification outbox backlog depth (pending + delivering; emitted only when the API reports it)
# TYPE sentinel_outbox_depth gauge
sentinel_outbox_depth 3
# HELP sentinel_outbox_dead_total Messages that exhausted their retry budget and sit in the dead-letter state
# TYPE sentinel_outbox_dead_total counter
sentinel_outbox_dead_total 1
# HELP sentinel_mttd_seconds Mean Time To Detect in seconds (chaos gate: must be < 60s); emitted only when known
# TYPE sentinel_mttd_seconds gauge
sentinel_mttd_seconds 12.5
# HELP sentinel_mttr_seconds Mean Time To Restore in seconds; emitted only when known
# TYPE sentinel_mttr_seconds gauge
sentinel_mttr_seconds 480
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(expected),
		"sentinel_service_up",
		"sentinel_service_uptime_ratio",
		"sentinel_service_sla_target",
		"sentinel_service_live_up",
		"sentinel_service_live_stale",
		"sentinel_transactions_lost_total",
		"sentinel_revenue_loss_tomans_total",
		"sentinel_sla_penalty_tomans_total",
		"sentinel_tenant_revenue_loss_tomans_total",
		"sentinel_tenant_penalty_tomans_total",
		"sentinel_fleet_uptime_ratio",
		"sentinel_sla_compliant_services",
		"sentinel_services_total",
		"sentinel_outbox_depth",
		"sentinel_outbox_dead_total",
		"sentinel_mttd_seconds",
		"sentinel_mttr_seconds",
	); err != nil {
		t.Fatalf("metrics mapping mismatch:\n%v", err)
	}
}

func TestOngoingIncidentCount(t *testing.T) {
	c := New(newFixtureServer(t).URL)
	expected := `
# HELP sentinel_incident_active Count of ongoing incidents per service and severity (0 = healthy)
# TYPE sentinel_incident_active gauge
sentinel_incident_active{service="payments-api",severity="critical"} 1
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(expected), "sentinel_incident_active"); err != nil {
		t.Fatalf("incident mapping mismatch:\n%v", err)
	}
}

func TestOutboxAbsentNeverEmitted(t *testing.T) {
	// Without "outboxDepth" in the KPI block the collector must NOT emit
	// sentinel_outbox_depth — it never invents values.
	body := strings.Replace(fixtureDashboard, `"outboxDepth": 3`, `"outboxDepth": null`, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c := New(srv.URL)
	count := testutil.CollectAndCount(c, "sentinel_outbox_depth")
	if count != 0 {
		t.Fatalf("outbox_depth emitted despite null outboxDepth: %d series", count)
	}
}

func TestSnapshotKeptForExecutiveBrief(t *testing.T) {
	c := New(newFixtureServer(t).URL)
	snap := c.Snapshot()
	if snap != nil {
		t.Fatalf("snapshot must be nil before the first scrape")
	}
	// one collect populates the snapshot
	ch := make(chan prometheus.Metric, 64)
	go func() {
		c.Collect(ch)
		close(ch)
	}()
	for range ch {
	}
	snap = c.Snapshot()
	if snap == nil || len(snap.Services) != 2 {
		t.Fatalf("snapshot not populated after collect: %+v", snap)
	}
	if snap.KPIs.OutboxDepth == nil || *snap.KPIs.OutboxDepth != 3 {
		t.Fatalf("outbox depth not decoded: %+v", snap.KPIs.OutboxDepth)
	}
}

// TestFetchSendsBearerToken pins the v2.0.0 authentication contract: when a
// token is configured (SENTINEL_API_TOKEN → SetAuthToken), every dashboard
// fetch carries "Authorization: Bearer <token>"; without one, the header is
// absent. A 401 from the app would otherwise silence all sentinel_ metrics.
func TestFetchSendsBearerToken(t *testing.T) {
	var gotAuth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = append(gotAuth, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fixtureDashboard))
	}))
	defer srv.Close()

	// without a token: no Authorization header at all
	c := New(srv.URL)
	if _, err := c.fetch(); err != nil {
		t.Fatalf("unauthenticated fetch failed: %v", err)
	}
	if len(gotAuth) != 1 || gotAuth[0] != "" {
		t.Fatalf("expected no Authorization header, got %q", gotAuth)
	}

	// with a token: exact Bearer header, and the scrape still succeeds
	c.SetAuthToken("stlt_testtoken1234567890")
	if _, err := c.fetch(); err != nil {
		t.Fatalf("authenticated fetch failed: %v", err)
	}
	if len(gotAuth) != 2 || gotAuth[1] != "Bearer stlt_testtoken1234567890" {
		t.Fatalf("expected Bearer header, got %q", gotAuth)
	}

	// clearing the token removes the header again
	c.SetAuthToken("")
	if _, err := c.fetch(); err != nil {
		t.Fatalf("cleared-token fetch failed: %v", err)
	}
	if len(gotAuth) != 3 || gotAuth[2] != "" {
		t.Fatalf("expected cleared Authorization header, got %q", gotAuth)
	}
}
