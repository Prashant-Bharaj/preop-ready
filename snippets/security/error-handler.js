/**
 * SNIPPET: API Error Handler
 * CATEGORY: Security
 * LANGUAGE: JavaScript (Express)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Global Express error handler that returns descriptive JSON error
 *   responses with proper HTTP status codes. Never leaks stack traces,
 *   internal paths, or database details to clients — the full error is
 *   logged server-side only. 500s get a generic message; 4xx errors get
 *   a specific message so the client can fix the request.
 *
 *   Standard error response format:
 *   { "error": "NOT_FOUND", "message": "User with ID 42 was not found", "statusCode": 404 }
 *
 * HTTP STATUS CODE GUIDE:
 *   | Code | When to Use                                            |
 *   |------|--------------------------------------------------------|
 *   | 400  | Bad request — invalid input, missing fields            |
 *   | 401  | Unauthorized — not authenticated                       |
 *   | 403  | Forbidden — authenticated but no permission            |
 *   | 404  | Not found — resource doesn't exist                     |
 *   | 409  | Conflict — duplicate entry, version mismatch           |
 *   | 422  | Unprocessable — valid format but failed business rules |
 *   | 429  | Too many requests — rate limited                       |
 *   | 500  | Internal error — unexpected server failure             |
 *
 * DEPENDENCIES:
 *   None - uses built-in Express features
 *
 * USAGE:
 *   const { errorHandler, ApiError, notFound } = require('./middleware/error-handler');
 *
 *   // In routes: throw ApiError (or use the helpers) and pass to next()
 *   app.get('/users/:id', async (req, res, next) => {
 *     try {
 *       const user = await getUser(req.params.id);
 *       if (!user) throw notFound(`User with ID ${req.params.id} was not found`);
 *       res.json(user);
 *     } catch (err) {
 *       next(err);
 *     }
 *   });
 *
 *   // Register AFTER all routes (must be last):
 *   app.use(errorHandler);
 */

// ============================================
// ERROR CLASS
// ============================================

/**
 * Operational API error with status code and machine-readable code.
 * @param {string} message - Human-readable message (safe for clients)
 * @param {number} statusCode - HTTP status code
 * @param {string} code - Machine-readable error code (e.g. 'NOT_FOUND')
 */
class ApiError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ============================================
// ERROR HELPERS
// ============================================

const badRequest = (message = 'Invalid request') =>
  new ApiError(message, 400, 'BAD_REQUEST');

const unauthorized = (message = 'Authentication required') =>
  new ApiError(message, 401, 'UNAUTHORIZED');

const forbidden = (message = 'You do not have permission to do this') =>
  new ApiError(message, 403, 'FORBIDDEN');

const notFound = (message = 'Resource not found') =>
  new ApiError(message, 404, 'NOT_FOUND');

const conflict = (message = 'Resource already exists') =>
  new ApiError(message, 409, 'CONFLICT');

const unprocessable = (message = 'Request failed business rules') =>
  new ApiError(message, 422, 'UNPROCESSABLE');

const tooManyRequests = (message = 'Too many requests, slow down') =>
  new ApiError(message, 429, 'TOO_MANY_REQUESTS');

// ============================================
// GLOBAL ERROR HANDLER MIDDLEWARE
// ============================================

/**
 * Global error handler — add AFTER all routes.
 * Logs the full error server-side, returns safe JSON to the client.
 */
const errorHandler = (err, req, res, next) => {
  console.error(err); // Log full error (with stack) server-side only

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.code || 'INTERNAL_ERROR',
    message: statusCode === 500
      ? 'An unexpected error occurred'  // Hide internal details from clients
      : err.message,
    statusCode
  });
};

/**
 * Catch-all for unknown routes — add after all routes, BEFORE errorHandler.
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} does not exist`,
    statusCode: 404
  });
};

module.exports = {
  ApiError,
  errorHandler,
  notFoundHandler,

  // Helpers
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests
};
