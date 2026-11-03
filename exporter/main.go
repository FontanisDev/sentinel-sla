// ═══════════════════════════════════════════════════════════════════════════
// sentinel-business-exporter — entrypoint
// Owner: Sentinel-SLA
//
// Custom Go exporter. Two jobs:
//
//   1. /metrics                    — Prometheus scrape endpoint fed by the
//                                    custom collector (business + financial
//                                    metrics; see internal/collector).
//   2. /webhook/executive-alert    — receives Alertmanager webhooks for
//                                    CRITICAL alerts and translates them from
//                                    technical language ("ServiceDown") into
//                                    EXECUTIVE language (lost transactions,
//                                    Tomans) using the last scraped snapshot,
//                                    then logs the brief for the delivery
//                                    channel (Telegram CEO chat, email, ...).
//
// Run:  ./sentinel-exporter --listen :9108 --api http://localhost:3000
// ═══════════════════════════════════════════════════════════════════════════
package main

import (
        "encoding/json"
        "flag"
        "log"
        "net/http"
        "os"
        "time"

        "github.com/prometheus/client_golang/prometheus"
        "github.com/prometheus/client_golang/prometheus/promhttp"

        "github.com/FontanisDev/sentinel-sla/exporter/internal/collector"
)

// alertmanagerWebhook is the payload Alertmanager POSTs
// (https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).
type alertmanagerWebhook struct {
        Receiver string  `json:"receiver"`
        Status   string  `json:"status"` // firing | resolved
        Alerts   []alert `json:"alerts"`
}

type alert struct {
        Status      string            `json:"status"` // firing | resolved
        Labels      map[string]string `json:"labels"`
        Annotations map[string]string `json:"annotations"`
        StartsAt    time.Time         `json:"startsAt"`
        EndsAt      time.Time         `json:"endsAt"`
}

func main() {
        listen := flag.String("listen", ":9108", "HTTP listen address for /metrics and the executive webhook")
        api := flag.String("api", "http://localhost:3000", "Base URL of the Sentinel-SLA dashboard API")
        flag.Parse()

        // env var wins for the API base when set (docker-compose wiring)
        if env := os.Getenv("SENTINEL_API_BASE"); env != "" {
                *api = env
        }

        col := collector.New(*api)
        // v2.0.0: /api/dashboard requires authentication. SENTINEL_API_TOKEN is a
        // Bearer API token minted in the app (`bun scripts/mint-loadtest-token.mjs
        // --name exporter`); without it every scrape is a 401 and no metrics flow.
        if tok := os.Getenv("SENTINEL_API_TOKEN"); tok != "" {
                col.SetAuthToken(tok)
                log.Printf("sentinel-business-exporter: Bearer authentication enabled (SENTINEL_API_TOKEN)")
        }
        prometheus.MustRegister(col)

        mux := http.NewServeMux()
        mux.Handle("/metrics", promhttp.Handler())
        mux.HandleFunc("/webhook/executive-alert", executiveAlertHandler(col))
        mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
                w.WriteHeader(http.StatusOK)
                _, _ = w.Write([]byte("ok"))
        })

        srv := &http.Server{
                Addr:         *listen,
                Handler:      mux,
                ReadTimeout:  10 * time.Second,
                WriteTimeout: 15 * time.Second,
                IdleTimeout:  60 * time.Second,
        }

        log.Printf("sentinel-business-exporter: listening on %s (dashboard API: %s)", *listen, *api)
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
                log.Fatalf("sentinel-business-exporter: server error: %v", err)
        }
}

// executiveAlertHandler decodes Alertmanager webhooks and produces the
// executive-language briefs. Keep it simple but real: decode → enrich with
// financial figures from the last scrape → log (stdout) → acknowledge.
func executiveAlertHandler(col *collector.Collector) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
                if r.Method != http.MethodPost {
                        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                        return
                }

                var wh alertmanagerWebhook
                dec := json.NewDecoder(r.Body)
                if err := dec.Decode(&wh); err != nil {
                        log.Printf("executive-alert: cannot decode webhook payload: %v", err)
                        http.Error(w, "invalid json payload", http.StatusBadRequest)
                        return
                }

                snap := col.Snapshot() // may be nil before the first successful scrape

                briefs := 0
                for _, a := range wh.Alerts {
                        alertname := a.Labels["alertname"]
                        service := a.Labels["service"]
                        if service == "" {
                                service = a.Labels["instance"]
                        }
                        severity := a.Labels["severity"]
                        summary := a.Annotations["summary"]

                        // financial note from the last scraped business metrics
                        financial := "financial figures pending next scrape of the Sentinel API"
                        if snap != nil {
                                for _, s := range snap.Services {
                                        if s.Key == service || s.Name == service {
                                                financial = formatTomans(s.RevenueLossTomans, s.PenaltyTomans)
                                                break
                                        }
                                }
                        }

                        statusLine := "RESOLVED"
                        if a.Status == "firing" {
                                statusLine = "ACTIVE INCIDENT"
                        }

                        // ── The executive translation (this is the product's core promise)
                        brief := "EXECUTIVE BRIEF — Sentinel-SLA\n" +
                                "[" + statusLine + "] " + alertname + " on " + service + " (severity: " + severity + ")\n" +
                                "Technical summary: " + summary + "\n" +
                                "Financial impact: " + financial + "\n" +
                                "خلاصه مدیریت: رخداد " + alertname + " روی سرویس " + service + " — تأثیر مالی در بخش بالا (تومان)."

                        log.Printf("executive-alert:\n%s\n", brief)
                        briefs++
                }

                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusOK)
                resp := map[string]interface{}{
                        "status":   "ok",
                        "briefs":   briefs,
                        "language": "executive",
                }
                _ = json.NewEncoder(w).Encode(resp)
        }
}

// formatTomans renders the financial note the CEO actually reads.
func formatTomans(revenueLoss, penalty float64) string {
        return "revenue loss to date: " + tomans(revenueLoss) +
                " Tomans; SLA penalty exposure: " + tomans(penalty) + " Tomans"
}

// tomans formats with thousands separators using only the standard library.
func tomans(v float64) string {
        if v < 0 {
                v = 0
        }
        whole := int64(v)
        frac := v - float64(whole)
        s := int64String(whole)
        if frac >= 0.5 { // round up on halves — money stays conservative for the exec
                s = int64String(whole + 1)
        }
        return s
}

// int64String inserts ',' every three digits (no locale dependency).
func int64String(v int64) string {
        if v == 0 {
                return "0"
        }
        neg := v < 0
        if neg {
                v = -v
        }
        var out []byte
        for digits := 0; v > 0; digits++ {
                if digits > 0 && digits%3 == 0 {
                        out = append(out, ',')
                }
                out = append(out, byte('0'+v%10))
                v /= 10
        }
        if neg {
                out = append(out, '-')
        }
        // reverse
        for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
                out[i], out[j] = out[j], out[i]
        }
        return string(out)
}
