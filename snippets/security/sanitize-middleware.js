/**
 * SNIPPET: Global Sanitization Middleware
 * CATEGORY: Security
 * LANGUAGE: JavaScript (Express)
 * STATUS: ✅ Ready
 *
 * DESCRIPTION:
 *   Global middleware that automatically sanitizes ALL incoming request bodies
 *   and ALL outgoing JSON responses. Acts as a safety net — even if per-route
 *   validation is forgotten, this catches dangerous input/output.
 *
 *   Also includes per-route helpers: isPositiveInt, isAllowedValue,
 *   validateRequiredFields, enforceMaxLengths.
 *
 * DEPENDENCIES:
 *   npm install sanitize-html
 *
 * USAGE:
 *   const { sanitizeBody, sanitizeResponse } = require('./middleware/sanitize');
 *
 *   // Apply BEFORE routes
 *   app.use(express.json({ limit: '100kb' }));
 *   app.use(sanitizeBody);
 *   app.use(sanitizeResponse);
 *
 *   // Per-route helpers
 *   app.get('/items/:id', (req, res) => {
 *     if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
 *     ...
 *   });
 *
 * IMPORTANT:
 *   - Apply sanitizeBody AFTER express.json() but BEFORE routes
 *   - Apply sanitizeResponse BEFORE routes (it wraps res.json)
 *   - Set express.json({ limit: '100kb' }) to prevent large payload attacks
 *   - These are a SAFETY NET, not a replacement for per-route validation
 */

// ============================================
// GLOBAL SANITIZATION MIDDLEWARE
// ============================================

const sanitizeHtml = require('sanitize-html');

/**
 * Strip ALL HTML tags from a string value.
 * Uses sanitize-html library (not regex) for robust protection against
 * XSS bypasses like unclosed tags, nested encoding, and attribute injection.
 * @param {string} str
 * @returns {string}
 */
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return sanitizeHtml(str, { allowedTags: [], allowedAttributes: {} });
}

/**
 * Recursively sanitize all string values in an object/array.
 * Strips HTML tags and trims whitespace.
 * @param {*} obj
 * @returns {*}
 */
function deepSanitize(obj) {
  if (typeof obj === 'string') {
    return stripHtml(obj).trim();
  }
  if (Array.isArray(obj)) {
    return obj.map(deepSanitize);
  }
  if (obj && typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = deepSanitize(value);
    }
    return sanitized;
  }
  return obj;
}

/**
 * Middleware: sanitize all string values in req.body.
 * Apply AFTER express.json(), BEFORE routes.
 */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitize(req.body);
  }
  next();
}

/**
 * Middleware: sanitize all string values in JSON responses.
 * Wraps res.json() to strip HTML from outgoing data.
 */
function sanitizeResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (data && typeof data === 'object') {
      data = deepSanitize(data);
    }
    return originalJson(data);
  };
  next();
}

// ============================================
// GLOBAL ERROR HANDLER
// ============================================

/**
 * Global error handler — add AFTER all routes.
 * Returns generic message for 500s, never exposes stack traces.
 */
function globalErrorHandler(err, req, res, _next) {
  console.error('[Error]', err);

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.code || 'INTERNAL_ERROR',
    message: statusCode === 500
      ? 'An unexpected error occurred'
      : err.message,
  });
}

// ============================================
// PER-ROUTE VALIDATION HELPERS
// ============================================

/**
 * Check if a value is a positive integer (for :id params).
 * @param {string|number} value
 * @returns {boolean}
 */
function isPositiveInt(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0;
}

/**
 * Check if a value is in an allowed list (for query params / enums).
 * @param {string} value
 * @param {string[]} allowed
 * @returns {boolean}
 */
function isAllowedValue(value, allowed) {
  return allowed.includes(value);
}

/**
 * Validate that required fields are present in req.body.
 * Returns array of missing field names, or empty array if all present.
 * @param {object} body - req.body
 * @param {string[]} fields - required field names
 * @returns {string[]} missing fields
 */
function validateRequiredFields(body, fields) {
  return fields.filter(f => body[f] === undefined || body[f] === null || body[f] === '');
}

/**
 * Enforce max lengths on string fields. Returns array of violations.
 * @param {object} body - req.body
 * @param {object} maxLengths - { fieldName: maxLength }
 * @returns {Array<{field: string, max: number, actual: number}>}
 */
function enforceMaxLengths(body, maxLengths) {
  const violations = [];
  for (const [field, max] of Object.entries(maxLengths)) {
    if (typeof body[field] === 'string' && body[field].length > max) {
      violations.push({ field, max, actual: body[field].length });
    }
  }
  return violations;
}

// ============================================
// SETUP HELPER
// ============================================

/**
 * Apply all global security middleware to an Express app.
 * Call this ONCE during app setup, BEFORE defining routes.
 *
 * @param {import('express').Express} app
 *
 * @example
 *   const express = require('express');
 *   const { applySecurityMiddleware } = require('./middleware/sanitize');
 *
 *   const app = express();
 *   applySecurityMiddleware(app);
 *
 *   // Define routes AFTER this
 *   app.get('/health', (req, res) => res.json({ status: 'ok' }));
 *
 *   // Add error handler AFTER routes
 *   app.use(globalErrorHandler);
 */
function applySecurityMiddleware(app) {
  // Limit payload size to prevent large payload attacks
  // Default: 1mb. Adjust based on your use case (file uploads use multer, not this)
  app.use(require('express').json({ limit: '1mb' }));
  app.use(require('express').urlencoded({ extended: false, limit: '1mb' }));

  // Sanitize all incoming request bodies
  app.use(sanitizeBody);

  // Sanitize all outgoing JSON responses
  app.use(sanitizeResponse);
}

module.exports = {
  // Global middleware
  sanitizeBody,
  sanitizeResponse,
  globalErrorHandler,
  applySecurityMiddleware,

  // Sanitization functions
  stripHtml,
  deepSanitize,

  // Per-route helpers
  isPositiveInt,
  isAllowedValue,
  validateRequiredFields,
  enforceMaxLengths,
};