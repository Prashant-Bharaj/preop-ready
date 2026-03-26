/**
 * SNIPPET: React DatePicker Components
 * CATEGORY: UI
 * LANGUAGE: JavaScript (React)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Date picker and date range picker components using native <input type="date">.
 *   No external dependencies. Includes helper functions for formatting and validation.
 *   Controlled components with value/onChange, min/max, label, required, disabled props.
 *
 * DEPENDENCIES:
 *   React 18+
 *
 * USAGE:
 *   import { DatePicker, DateRangePicker, formatDateForAPI, formatDateForDisplay } from './datepicker-react';
 *
 *   // Single date
 *   const [date, setDate] = useState('');
 *   <DatePicker label="Start Date" value={date} onChange={setDate} required />
 *
 *   // Date range
 *   const [start, setStart] = useState('');
 *   const [end, setEnd] = useState('');
 *   <DateRangePicker
 *     startValue={start} endValue={end}
 *     onStartChange={setStart} onEndChange={setEnd}
 *     startLabel="From" endLabel="To"
 *   />
 *
 *   // Helpers
 *   formatDateForAPI(new Date());              // "2024-01-15"
 *   formatDateForDisplay('2024-01-15', 'de');  // "15.1.2024"
 *   isValidDateRange('2024-01-01', '2024-12-31'); // true
 *
 * COMMON PITFALLS:
 *   1. Always use YYYY-MM-DD format for API calls. This is the only format
 *      guaranteed to parse consistently across browsers and backends.
 *
 *   2. new Date('2024-01-15') creates UTC midnight. In negative UTC offsets
 *      (e.g., US timezones), this displays as the PREVIOUS day (Jan 14).
 *      Fix: use new Date('2024-01-15T00:00:00') to force local timezone.
 *
 *   3. Don't store dates as display strings (e.g., "January 15, 2024").
 *      Always store as ISO 8601 (YYYY-MM-DD) and format on display.
 *
 *   4. Native <input type="date"> always works with YYYY-MM-DD internally,
 *      but displays in the user's locale. This is correct behavior.
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#374151',
  },
  required: {
    color: '#ef4444',
    marginLeft: '2px',
  },
  input: {
    padding: '8px 12px',
    fontSize: '14px',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    outline: 'none',
    transition: 'border-color 0.15s ease',
    backgroundColor: '#fff',
    color: '#111827',
    width: '100%',
    boxSizing: 'border-box',
  },
  inputFocused: {
    borderColor: '#3b82f6',
    boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.2)',
  },
  inputDisabled: {
    backgroundColor: '#f3f4f6',
    color: '#9ca3af',
    cursor: 'not-allowed',
  },
  inputError: {
    borderColor: '#ef4444',
  },
  error: {
    fontSize: '12px',
    color: '#ef4444',
    marginTop: '2px',
  },
  rangeContainer: {
    display: 'flex',
    gap: '16px',
    alignItems: 'flex-start',
  },
  rangeField: {
    flex: 1,
  },
  rangeSeparator: {
    display: 'flex',
    alignItems: 'center',
    paddingTop: '24px',
    color: '#6b7280',
    fontSize: '14px',
  },
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Format a Date object to ISO 8601 date string (YYYY-MM-DD) for API calls.
 * Uses local date components to avoid timezone shifting.
 * @param {Date} date - Date object
 * @returns {string} ISO date string (YYYY-MM-DD)
 */
export function formatDateForAPI(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a YYYY-MM-DD date string for display in the user's locale.
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @param {string} [locale='en'] - BCP 47 locale string (e.g., 'de', 'en-US')
 * @returns {string} Localized date string
 */
export function formatDateForDisplay(dateStr, locale = 'en') {
  if (!dateStr) return '';
  // Force local timezone to avoid off-by-one day errors
  const date = new Date(dateStr + 'T00:00:00');
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Validate that a date range is valid (end >= start).
 * @param {string} start - Start date (YYYY-MM-DD)
 * @param {string} end - End date (YYYY-MM-DD)
 * @returns {boolean} True if range is valid
 */
export function isValidDateRange(start, end) {
  if (!start || !end) return true; // partial range is considered valid
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return false;
  return endDate >= startDate;
}

// ---------------------------------------------------------------------------
// DatePicker Component
// ---------------------------------------------------------------------------

/**
 * Controlled date picker using native <input type="date">.
 *
 * @param {object} props
 * @param {string} props.value - Current value (YYYY-MM-DD)
 * @param {function} props.onChange - Called with new value string (YYYY-MM-DD)
 * @param {string} [props.label] - Label text
 * @param {string} [props.min] - Minimum date (YYYY-MM-DD)
 * @param {string} [props.max] - Maximum date (YYYY-MM-DD)
 * @param {boolean} [props.required] - Whether field is required
 * @param {boolean} [props.disabled] - Whether field is disabled
 * @param {string} [props.error] - Error message to display
 * @param {string} [props.id] - Input element id
 * @param {object} [props.style] - Additional styles for container
 */
export function DatePicker({
  value,
  onChange,
  label,
  min,
  max,
  required = false,
  disabled = false,
  error,
  id,
  style,
}) {
  const [focused, setFocused] = React.useState(false);
  const inputId = id || React.useId();

  const inputStyle = {
    ...styles.input,
    ...(focused ? styles.inputFocused : {}),
    ...(disabled ? styles.inputDisabled : {}),
    ...(error ? styles.inputError : {}),
  };

  return (
    <div style={{ ...styles.container, ...style }}>
      {label && (
        <label htmlFor={inputId} style={styles.label}>
          {label}
          {required && <span style={styles.required}>*</span>}
        </label>
      )}
      <input
        id={inputId}
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        min={min}
        max={max}
        required={required}
        disabled={disabled}
        style={inputStyle}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
      />
      {error && (
        <span id={`${inputId}-error`} style={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateRangePicker Component
// ---------------------------------------------------------------------------

/**
 * Date range picker with start and end date validation.
 *
 * @param {object} props
 * @param {string} props.startValue - Start date (YYYY-MM-DD)
 * @param {string} props.endValue - End date (YYYY-MM-DD)
 * @param {function} props.onStartChange - Called with new start value
 * @param {function} props.onEndChange - Called with new end value
 * @param {string} [props.startLabel] - Label for start date (default: "Start Date")
 * @param {string} [props.endLabel] - Label for end date (default: "End Date")
 * @param {string} [props.min] - Minimum date for both inputs
 * @param {string} [props.max] - Maximum date for both inputs
 * @param {boolean} [props.required] - Whether both fields are required
 * @param {boolean} [props.disabled] - Whether both fields are disabled
 * @param {object} [props.style] - Additional styles for container
 */
export function DateRangePicker({
  startValue,
  endValue,
  onStartChange,
  onEndChange,
  startLabel = 'Start Date',
  endLabel = 'End Date',
  min,
  max,
  required = false,
  disabled = false,
  style,
}) {
  const rangeValid = isValidDateRange(startValue, endValue);
  const rangeError = !rangeValid ? 'End date must be on or after start date' : undefined;

  return (
    <div style={{ ...styles.rangeContainer, ...style }}>
      <div style={styles.rangeField}>
        <DatePicker
          label={startLabel}
          value={startValue}
          onChange={onStartChange}
          min={min}
          max={endValue || max}
          required={required}
          disabled={disabled}
        />
      </div>
      <div style={styles.rangeSeparator}>to</div>
      <div style={styles.rangeField}>
        <DatePicker
          label={endLabel}
          value={endValue}
          onChange={onEndChange}
          min={startValue || min}
          max={max}
          required={required}
          disabled={disabled}
          error={rangeError}
        />
      </div>
    </div>
  );
}

export default DatePicker;
