package main

// Unit tests for the executive-brief generator.
//
// The brief generator is the product's core promise — technical alerts in,
// executive money-language out — so the translation layer is pinned by tests:
// number formatting (thousands separators, conservative half-up rounding,
// negative clamp) and the webhook round-trip with snapshot enrichment.
//
// Run: cd exporter && go test ./...

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/FontanisDev/sentinel-sla/exporter/internal/collector"
	"github.com/prometheus/client_golang/prometheus"
)

// collectOnce drives one Collect pass so the snapshot cache is populated.
func collectOnce(col *collector.Collector) {
	ch := make(chan prometheus.Metric, 64)
	go func() {
		col.Collect(ch)
		close(ch)
	}()
	for range ch {
	}
}

func TestTomansFormatting(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{1, "1"},
		{999, "999"},
		{1000, "1,000"},
		{1234567, "1,234,567"},
		{1234567890, "1,234,567,890"},
		{1500.4, "1,500"}, // fraction below .5 → floor
		{1500.5, "1,501"}, // half rounds UP — money stays conservative for the exec
		{1500.9, "1,501"}, // fraction rounds up
		{-42, "0"},        // negatives clamp to zero (no negative money in briefs)
	}
	for _, c := range cases {
		if got := tomans(c.in); got != c.want {
			t.Errorf("tomans(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFormatTomansExecutiveNote(t *testing.T) {
	want := "revenue loss to date: 240,000,000 Tomans; SLA penalty exposure: 22,500,000 Tomans"
	if got := formatTomans(240000000, 22500000); got != want {
		t.Errorf("formatTomans = %q, want %q", got, want)
	}
}

func TestExecutiveAlertHandlerEnrichesBrief(t *testing.T) {
	// minimal dashboard fixture so the handler can enrich the brief with money
	fixture := `{
          "services": [
            {"id":"s1","key":"payments-api","name":"Payments API","tier":"tier-1",
             "criticality":"critical","status":"down","latencyMs":1,"errorRate":0.5,
             "throughput":0,"uptime":0.99,"slaTarget":0.999,
             "revenueLossTomans":240000000,"penaltyTomans":22500000}
          ],
          "incidents": [],
          "kpis": {"avgMttdSec": null, "avgMttrSec": null}
        }`
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(fixture))
	}))
	defer api.Close()

	col := collector.New(api.URL)
	handler := executiveAlertHandler(col)

	// warm the snapshot (the handler enriches briefs from the last scrape)
	collectOnce(col)

	payload := map[string]interface{}{
		"receiver": "exec",
		"status":   "firing",
		"alerts": []map[string]interface{}{
			{
				"status": "firing",
				"labels": map[string]string{
					"alertname": "ServiceDown",
					"service":   "payments-api",
					"severity":  "critical",
				},
				"annotations": map[string]string{"summary": "blackbox probe failing"},
			},
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/webhook/executive-alert", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	// capture the logged brief
	var logBuf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevOut)

	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("webhook returned HTTP %d, want 200", rec.Code)
	}
	var resp struct {
		Status string `json:"status"`
		Briefs int    `json:"briefs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "ok" || resp.Briefs != 1 {
		t.Fatalf("response = %+v, want status ok with 1 brief", resp)
	}

	logged := logBuf.String()
	for _, want := range []string{
		"ACTIVE INCIDENT",
		"ServiceDown on payments-api",
		"revenue loss to date: 240,000,000 Tomans",
		"خلاصه مدیریت",
	} {
		if !strings.Contains(logged, want) {
			t.Errorf("logged brief missing %q\ngot: %s", want, logged)
		}
	}
}

func TestExecutiveAlertHandlerRejectsBadPayload(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"services":[],"incidents":[],"kpis":{}}`))
	}))
	defer api.Close()

	handler := executiveAlertHandler(collector.New(api.URL))
	req := httptest.NewRequest(http.MethodPost, "/webhook/executive-alert", strings.NewReader("{not json"))
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid payload returned HTTP %d, want 400", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/webhook/executive-alert", nil)
	rec = httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET returned HTTP %d, want 405", rec.Code)
	}
}

func TestExecutiveBriefWithoutSnapshotStillAcknowledge(t *testing.T) {
	// No scrape yet — the brief must still be produced with the pending-money
	// note instead of crashing (executive channel must never go dark).
	handler := executiveAlertHandler(collector.New("http://127.0.0.1:1")) // nothing listens here
	payload := map[string]interface{}{
		"status": "firing",
		"alerts": []map[string]interface{}{
			{
				"status":      "firing",
				"labels":      map[string]string{"alertname": "HighErrorRate", "service": "x", "severity": "warning"},
				"annotations": map[string]string{"summary": "s"},
			},
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/webhook/executive-alert", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	defer log.SetOutput(nil)

	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("webhook returned HTTP %d, want 200 even without snapshot", rec.Code)
	}
	if !strings.Contains(logBuf.String(), "financial figures pending next scrape") {
		t.Errorf("pending-money note missing from brief: %s", logBuf.String())
	}
}
