/**
 * SNIPPET: Input Validation Middleware
 * CATEGORY: Security
 * LANGUAGE: JavaScript (Express)
 * STATUS: ✅ Ready
 * 
 * DESCRIPTION: 
 *   Server-side input validation using express-validator.
 *   Prevents injection attacks and ensures data integrity.
 *   NEVER trust client-side validation alone!
 * 
 * DEPENDENCIES: 
 *   npm install express-validator
 * 
 * USAGE:
 *   const { validateUser, validateId } = require('./middleware/validation');
 *   
 *   app.post('/users', validateUser, (req, res) => { ... });
 *   app.get('/users/:id', validateId, (req, res) => { ... });
 * 
 * EXAMPLE:
 *   // Validation automatically returns 400 with error details
 *   // POST /users with invalid email returns:
 *   // { "errors": [{ "msg": "Invalid email", "path": "email" }] }
 */

const { body, param, query, validationResult } = require('express-validator');

// ============================================
// VALIDATION RESULT HANDLER
// ============================================

/**
 * Middleware to check validation results and return errors
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed',
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg
      }))
    });
  }
  next();
};

// ============================================
// COMMON VALIDATORS
// ============================================

/**
 * Validate user creation/update
 */
const validateUser = [
  body('email')
    .isEmail().withMessage('Invalid email address')
    .normalizeEmail(),
  
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Name must be 1-100 characters')
    .escape(),  // Prevent XSS
  
  body('age')
    .optional()
    .isInt({ min: 0, max: 150 }).withMessage('Age must be 0-150'),
  
  handleValidationErrors
];

/**
 * Validate ID parameter (numeric)
 */
const validateId = [
  param('id')
    .isInt({ min: 1 }).withMessage('ID must be a positive integer'),
  
  handleValidationErrors
];

/**
 * Validate UUID parameter
 */
const validateUuid = [
  param('id')
    .isUUID().withMessage('Invalid UUID format'),
  
  handleValidationErrors
];

/**
 * Validate pagination query parameters
 */
const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('Page must be positive integer')
    .toInt(),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100')
    .toInt(),
  
  handleValidationErrors
];

/**
 * Validate search query
 */
const validateSearch = [
  query('q')
    .trim()
    .isLength({ min: 1, max: 200 }).withMessage('Search query must be 1-200 characters')
    .escape(),
  
  handleValidationErrors
];

// ============================================
// CUSTOM VALIDATORS
// ============================================

/**
 * Create custom field validator
 * @param {string} field - Field name
 * @param {object} options - Validation options
 */
const createFieldValidator = (field, options = {}) => {
  const validators = [];
  
  if (options.required) {
    validators.push(
      body(field).exists().withMessage(`${field} is required`)
    );
  }
  
  if (options.type === 'email') {
    validators.push(
      body(field).isEmail().withMessage('Invalid email').normalizeEmail()
    );
  }
  
  if (options.type === 'string') {
    validators.push(
      body(field)
        .trim()
        .isLength({ 
          min: options.minLength || 1, 
          max: options.maxLength || 255 
        })
        .withMessage(`${field} must be ${options.minLength || 1}-${options.maxLength || 255} characters`)
        .escape()
    );
  }
  
  if (options.type === 'number') {
    validators.push(
      body(field)
        .isNumeric().withMessage(`${field} must be a number`)
    );
  }
  
  return validators;
};

// ============================================
// SANITIZATION HELPERS
// ============================================

/**
 * Sanitize object by removing dangerous fields
 * @param {object} obj - Object to sanitize
 * @param {string[]} allowedFields - Whitelist of allowed field names
 */
const sanitizeObject = (obj, allowedFields) => {
  const sanitized = {};
  for (const field of allowedFields) {
    if (obj.hasOwnProperty(field)) {
      sanitized[field] = obj[field];
    }
  }
  return sanitized;
};

/**
 * Remove HTML tags from string
 * @param {string} str - String to sanitize
 */
const stripHtml = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
};

module.exports = {
  // Middleware
  handleValidationErrors,
  
  // Pre-built validators
  validateUser,
  validateId,
  validateUuid,
  validatePagination,
  validateSearch,
  
  // Helpers
  createFieldValidator,
  sanitizeObject,
  stripHtml,
  
  // Re-export express-validator for custom use
  body,
  param,
  query,
  validationResult
};
