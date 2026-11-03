// Sentinel-SLA — HTTP helpers for API routes
// Consistent error shape { error, details? } with proper status codes.
//
// HMR note: the dev server can hold several module "generations" at once (the
// engine singleton may be older than a freshly compiled route). HttpError is
// therefore cached on globalThis so every generation shares one class
// identity, and toErrorResponse additionally accepts any Error carrying a
// numeric HTTP `status` (structural fallback for cross-generation instances).

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

type HttpErrorInstance = Error & { readonly status: number };
type HttpErrorConstructor = new (status: number, message: string) => HttpErrorInstance;

const globalForHttpError = globalThis as unknown as { __sentinelHttpError?: HttpErrorConstructor };

/** Error carrying an HTTP status code, thrown by server logic and mapped by routes. */
export const HttpError: HttpErrorConstructor =
  globalForHttpError.__sentinelHttpError ??
  class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = 'HttpError';
      this.status = status;
    }
  };

globalForHttpError.__sentinelHttpError = HttpError;

/** Parse a JSON request body; 400 on malformed input instead of an opaque 500. */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/** Map any thrown value to the API error contract. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // Structural fallback: an HttpError-shaped Error from another module
  // generation (HMR) still maps to its intended status code.
  if (err instanceof Error) {
    const status: unknown = (err as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
      return NextResponse.json({ error: err.message }, { status });
    }
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        details: err.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
      },
      { status: 400 },
    );
  }
  console.error('[sentinel:api] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
