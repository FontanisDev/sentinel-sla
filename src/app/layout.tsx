import type { Metadata } from "next";
import "./globals.css";
import { LazyToaster } from "@/components/sentinel/lazy-toaster";
import { QueryProvider } from "@/components/sentinel/providers";

// Fonts (Inter / Vazirmatn / JetBrains Mono) are bundled locally in
// /public/fonts and declared in globals.css — no Google Fonts or CDN calls
// at runtime (docs/DESIGN-SYSTEM.md, offline-first hard rule).

export const metadata: Metadata = {
  title: "Sentinel-SLA — Fintech Service Level Command Center",
  description:
    "SLA monitoring that speaks two languages: live engineering telemetry for DevOps and executive financial impact in Tomans. Chaos-driven MTTD/MTTR self-testing for Iranian fintech.",
  keywords: [
    "SLA monitoring",
    "SRE",
    "observability",
    "chaos engineering",
    "MTTD",
    "MTTR",
    "fintech",
  ],
  applicationName: "Sentinel-SLA",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased bg-app text-t1">
        <QueryProvider>{children}</QueryProvider>
        <LazyToaster />
      </body>
    </html>
  );
}
