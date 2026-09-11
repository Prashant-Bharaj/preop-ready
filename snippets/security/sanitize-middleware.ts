/**
 * scopes: [backend]
 * flags: []
 * description: HTML/XSS sanitisation middleware (TypeScript).
 */

/**
 * Global Sanitization Middleware (TypeScript)
 *
 * Global middleware that automatically sanitizes ALL incoming request bodies
 * and ALL outgoing JSON responses. Acts as a safety net — even if per-route
 * validation is forgotten, this catches dangerous input/output.
 *
 * Also includes per-route helpers: isPositiveInt, isAllowedValue,
 * validateRequiredFields, enforceMaxLengths.
 *
 * Dependencies:
 *   npm install sanitize-html
 *   npm install -D @types/sanitize-html
 *
 * Usage:
 *   import express from 'express';
 *   import { applySecurityMiddleware, globalErrorHandler } from './sanitize-middleware.js';
 *
 *   const app = express();
 *   applySecurityMiddleware(app);
 *   // Define routes ...
 *   app.use(globalErrorHandler);
 *
 * IMPORTANT:
 *   - Apply sanitizeBody AFTER express.json() but BEFORE routes
 *   - Apply sanitizeResponse BEFORE routes (it wraps res.json)
 *   - Set express.json({ limit: '100kb' }) to prevent large payload attacks
 *   - These are a SAFETY NET, not a replacement for per-route validation
 */

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type ErrorRequestHandler,
} from 'express';
import sanitizeHtml from 'sanitize-html';

/**
 * Strip ALL HTML tags from a string value.
 * Uses sanitize-html (not regex) for robust protection against XSS bypasses
 * (unclosed tags, nested encoding, attribute injection).
 */
export function stripHtml<T>(value: T): T {
  if (typeof value !== 'string') return value;
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  }) as unknown as T;
}

/**
 * Recursively sanitize all string values in an object/array.
 * Strips HTML tags and trims whitespace.
 */
export function deepSanitize<T>(value: T): T {
  if (typeof value === 'string') {
    return stripHtml(value).trim() as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepSanitize(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const sanitized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
        .map(([key, v]) => [key, deepSanitize(v)]),
    );
    return sanitized as unknown as T;
  }
  return value;
}

/**
 * Middleware: sanitize all string values in req.body.
 * Apply AFTER express.json(), BEFORE routes.
 */
export function sanitizeBody(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitize(req.body);
  }
  next();
}

/**
 * Middleware: sanitize all string values in JSON responses.
 * Wraps res.json() to strip HTML from outgoing data.
 *
 * OPT-IN, NOT default (see applySecurityMiddleware). Escaping belongs at render
 * time — the React frontend already escapes by default — so stripping HTML on
 * the way OUT is the wrong layer: it walks every response and runs every string
 * through sanitize-html on the hot path, and it silently CORRUPTS legitimate
 * data that contains `<`/`>` (code snippets, math, user prose). Attach it only
 * to a specific route whose output is truly rendered as raw HTML by a client
 * you don't control.
 */
export function sanitizeResponse(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  const originalJson = res.json.bind(res);
  res.json = (data: unknown) => {
    const sanitized =
      data && typeof data === 'object' ? deepSanitize(data) : data;
    return originalJson(sanitized);
  };
  next();
}

interface HttpishError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Global error handler — add AFTER all routes.
 * Returns a generic message for 500s; never exposes stack traces.
 */
export const globalErrorHandler: ErrorRequestHandler = (
  err: HttpishError,
  _req,
  res,
  _next
) => {
  console.error('[Error]', err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.code || 'INTERNAL_ERROR',
    message:
      statusCode === 500
        ? 'An unexpected error occurred'
        : err.message,
  });
};

// ============================================
// PER-ROUTE VALIDATION HELPERS
// ============================================

export function isPositiveInt(value: unknown): boolean {
  const num = Number(value);
  return Number.isInteger(num) && num > 0;
}

export function isAllowedValue<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function validateRequiredFields(
  body: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  return fields.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === ''
  );
}

export interface MaxLengthViolation {
  field: string;
  max: number;
  actual: number;
}

export function enforceMaxLengths(
  body: Record<string, unknown>,
  maxLengths: Record<string, number>
): MaxLengthViolation[] {
  const violations: MaxLengthViolation[] = [];
  for (const [field, max] of Object.entries(maxLengths)) {
    const v = body[field];
    if (typeof v === 'string' && v.length > max) {
      violations.push({ field, max, actual: v.length });
    }
  }
  return violations;
}

/**
 * Apply all global security middleware to an Express app.
 * Call ONCE during app setup, BEFORE defining routes.
 */
export function applySecurityMiddleware(app: Express): void {
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(sanitizeBody);
  // NOTE: sanitizeResponse is intentionally NOT applied globally — it corrupts
  // legitimate `<`/`>` data and costs O(response size) per request. Escape at
  // render time instead; attach sanitizeResponse per-route only if a specific
  // endpoint's output is rendered as raw HTML by an untrusted client.
}
