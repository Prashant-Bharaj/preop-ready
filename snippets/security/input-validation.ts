/**
 * scopes: [backend]
 * flags: []
 * description: Server-side input validation (TypeScript + Zod). Schemas + Express middleware for body/params/query.
 */

/**
 * Input Validation with Zod (TypeScript)
 *
 * Server-side validation using Zod schemas. Prevents injection attacks and
 * ensures data integrity. NEVER trust client-side validation alone.
 *
 * Dependencies:
 *   npm install zod
 *
 * Usage:
 *   import { z } from 'zod';
 *   import { validateBody, validateParams, validateQuery, UserCreateSchema } from './input-validation.js';
 *
 *   app.post('/users',  validateBody(UserCreateSchema),  (req, res) => { ... });
 *   app.get('/users/:id', validateParams(IdSchema),      (req, res) => { ... });
 *
 * Validation automatically returns 400 with error details on failure:
 *   { "error": "Validation failed", "errors": [{ "field": "email", "message": "Invalid email" }] }
 *
 * To define a new shape, import `z` and write a schema next to your route file:
 *   const CreateTaskSchema = z.object({
 *     title: z.string().min(1).max(200),
 *     dueDate: z.string().datetime().optional(),
 *   });
 *   app.post('/tasks', validateBody(CreateTaskSchema), (req, res) => { ... });
 */

import { z, type ZodSchema, type ZodIssue } from 'zod';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// ============================================
// PRE-BUILT SCHEMAS
// ============================================

export const EmailSchema = z.string().email('Invalid email address').toLowerCase();

export const UserCreateSchema = z.object({
  email: EmailSchema,
  name: z
    .string()
    .trim()
    .min(1, 'Name must be 1-100 characters')
    .max(100, 'Name must be 1-100 characters'),
  age: z.number().int().min(0).max(150).optional(),
});

export const IdParamSchema = z.object({
  id: z.coerce.number().int().positive('ID must be a positive integer'),
});

export const UuidParamSchema = z.object({
  id: z.string().uuid('Invalid UUID format'),
});

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const SearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, 'Search query must be 1-200 characters')
    .max(200, 'Search query must be 1-200 characters'),
});

// ============================================
// VALIDATION MIDDLEWARE
// ============================================

type RequestKey = 'body' | 'params' | 'query';

function formatIssues(issues: ZodIssue[]): Array<{ field: string; message: string }> {
  return issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

function makeValidator<S extends ZodSchema>(
  schema: S,
  key: RequestKey
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[key]);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        errors: formatIssues(result.error.issues),
      });
      return;
    }
    // Overwrite with the parsed/coerced value so handlers get the clean shape.
    (req as Record<RequestKey, unknown>)[key] = result.data;
    next();
  };
}

export function validateBody<S extends ZodSchema>(schema: S): RequestHandler {
  return makeValidator(schema, 'body');
}

export function validateParams<S extends ZodSchema>(schema: S): RequestHandler {
  return makeValidator(schema, 'params');
}

export function validateQuery<S extends ZodSchema>(schema: S): RequestHandler {
  return makeValidator(schema, 'query');
}

// ============================================
// SANITIZATION HELPERS
// ============================================

/**
 * Whitelist an object's fields. Returns a new object containing only the
 * specified `allowedFields` keys present in `obj`.
 */
export function sanitizeObject<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  allowedFields: readonly K[]
): Partial<Pick<T, K>> {
  const sanitized: Partial<Pick<T, K>> = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      sanitized[field] = obj[field];
    }
  }
  return sanitized;
}

/**
 * Remove HTML tags from a string. Returns the input unchanged if it's not a string.
 * Repeats until nothing changes so nested fragments (`<scr<script>ipt>`) cannot
 * survive a single pass. This is input hygiene, not output encoding — escape
 * on render regardless.
 */
export function stripHtml(str: string): string;
export function stripHtml<T>(str: T): T;
export function stripHtml(str: unknown): unknown {
  if (typeof str !== 'string') return str;
  let out = str;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== prev);
  return out;
}

// Re-export zod's `z` for callers that want to build schemas inline.
export { z };
