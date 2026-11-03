// Sentinel-SLA — proxy (Next 16 renamed middleware → proxy).
//
// Two jobs, both cheap:
//  1. Fast PRE-filter: a session cookie must be present for non-public paths.
//     It deliberately does NOT touch the database — the authoritative
//     per-route enforcement is requireUser / requireRole in
//     src/server/authz.ts, and the route-enumeration unit test
//     (tests/unit/authz-enumeration.test.ts) proves every route file calls it.
//  2. Security headers on EVERY response, public or not:
//     CSP with a per-request nonce (enforced in production,
//     report-only in development so HMR keeps working), frame-ancestors
//     'none', no sniffing, strict referrer, locked-down permissions policy,
//     HSTS when the operator declares TLS via SENTINEL_TLS.
//
// Public paths (mirrors the allow list in tests/unit/authz-enumeration.test.ts):
//   /login, /setup, /ack, /api/auth/*, /api/health/*, /api/integrations/*
//   (alertmanager uses its own bearer secret), next assets + icons.
//   /ack is the signed-link acknowledgement page (HMAC token IS the auth).

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PREFIXES = [
  '/login',
  '/setup',
  '/ack',
  '/api/auth/',
  '/api/health/',
  '/api/integrations/',
];

const PUBLIC_EXACT = new Set(['/robots.txt', '/favicon.ico', '/logo.svg']);

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/**
 * Content-Security-Policy "without unsafe-inline where feasible".
 * Feasible = scripts: production scripts get a per-request nonce +
 * strict-dynamic (Next injects the nonce into its bootstrap tags when the
 * policy is present on the REQUEST headers). Styles keep 'unsafe-inline' —
 * Tailwind injects style attributes at runtime; script-level protection is
 * the one that blocks XSS. In development the policy additionally ships
 * report-only because react-refresh needs 'unsafe-eval' + unsigned inline
 * bootstrap scripts.
 */
function buildCsp(nonce: string, isProd: boolean): string {
  const scriptSrc = isProd
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Attach the hardening header set to any response. */
function withSecurityHeaders(
  res: NextResponse,
  opts: { csp: string; isProd: boolean },
): NextResponse {
  if (!opts.isProd) {
    // Development only: same policy, report-only twin, so HMR violations are
    // visible in the console instead of silently blocked.
    res.headers.append('Content-Security-Policy-Report-Only', opts.csp);
  }
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-Frame-Options', 'DENY'); // legacy belt+braces beside frame-ancestors
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  // HSTS only when the operator declares TLS in front of the app.
  if (['1', 'true'].includes((process.env.SENTINEL_TLS ?? '').toLowerCase())) {
    res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  return res;
}

export function proxy(req: NextRequest) {
  const isProd = process.env.NODE_ENV === 'production';
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = buildCsp(nonce, isProd);

  const { pathname } = req.nextUrl;

  // Next.js reads the CSP from the request headers and applies the nonce to
  // its own <script> tags — this is what makes the nonce scheme work. It must
  // be set on EVERY HTML response (public pages like /login included).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  // Fast path: public assets/endpoints get headers but no auth work.
  if (isPublic(pathname)) {
    return withSecurityHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
      { csp, isProd },
    );
  }

  const hasSession = Boolean(req.cookies.get('sentinel_session')?.value);
  // machine clients authenticate with `Authorization: Bearer <api-token>`
  // (no cookie). This pre-filter is NOT the security boundary — the route's
  // requireUser/requireRole resolves the token against the DB (hashed, revocable,
  // expiring). We only need to let the header through instead of hard-401ing
  // requests that carry no cookie. Format check: at least 20 chars after Bearer.
  const hasBearer = /^Bearer\s+\S{20,}$/.test(req.headers.get('authorization') ?? '');

  if (!hasSession && !hasBearer) {
    // `/api` (exact, no trailing slash) and `/api/...` are both API surface.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return withSecurityHeaders(
        NextResponse.json(
          { error: 'Authentication required' },
          { status: 401, headers: { 'Cache-Control': 'no-store' } },
        ),
        { csp, isProd },
      );
    }
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    return withSecurityHeaders(NextResponse.redirect(loginUrl), { csp, isProd });
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  return withSecurityHeaders(res, { csp, isProd });
}

export const config = {
  // Next 16: proxy always runs on the Node.js runtime (no `runtime` key allowed).
  matcher: ['/((?!_next/static|_next/image).*)'],
};
