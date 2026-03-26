/**
 * SNIPPET: Vanilla JS DatePicker Components
 * CATEGORY: UI
 * LANGUAGE: JavaScript (Vanilla)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Date picker and date range picker using native <input type="date">.
 *   No framework dependencies. Pure JS/HTML/CSS.
 *   Includes helper functions for formatting and validation.
 *
 * DEPENDENCIES:
 *   None
 *
 * USAGE:
 *   // Include CSS
 *   injectDatePickerStyles();
 *
 *   // Single date picker
 *   const picker = createDatePicker(document.getElementById('date-container'), {
 *     label: 'Birthday',
 *     required: true,
 *     onChange: (value) => console.log('Selected:', value),
 *   });
 *   console.log(picker.getValue()); // "2024-01-15"
 *
 *   // Date range picker
 *   const range = createDateRangePicker(document.getElementById('range-container'), {
 *     startLabel: 'From',
 *     endLabel: 'To',
 *     onChange: ({ start, end }) => console.log('Range:', start, end),
 *   });
 *   console.log(range.getValues()); // { start: "2024-01-01", end: "2024-12-31" }
 *
 *   // Helpers
 *   formatDateForAPI(new Date());              // "2024-01-15"
 *   formatDateForDisplay('2024-01-15', 'de');  // "15. Januar 2024"
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

// ---------------------------------------------------------------------------
// CSS Styles
// ---------------------------------------------------------------------------

const DATE_PICKER_CSS = `
.dp-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dp-label {
  font-size: 14px;
  font-weight: 500;
  color: #374151;
}

.dp-required {
  color: #ef4444;
  margin-left: 2px;
}

.dp-input {
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  background-color: #fff;
  color: #111827;
  width: 100%;
  box-sizing: border-box;
}

.dp-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.dp-input:disabled {
  background-color: #f3f4f6;
  color: #9ca3af;
  cursor: not-allowed;
}

.dp-input--error {
  border-color: #ef4444;
}

.dp-error {
  font-size: 12px;
  color: #ef4444;
  margin-top: 2px;
}

.dp-range {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.dp-range__field {
  flex: 1;
}

.dp-range__separator {
  display: flex;
  align-items: center;
  padding-top: 24px;
  color: #6b7280;
  font-size: 14px;
}
`;

/**
 * Inject date picker CSS into the document head.
 * Safe to call multiple times (only injects once).
 */
function injectDatePickerStyles() {
  if (document.getElementById('dp-styles')) return;
  const style = document.createElement('style');
  style.id = 'dp-styles';
  style.textContent = DATE_PICKER_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Format a Date object to ISO 8601 date string (YYYY-MM-DD) for API calls.
 * Uses local date components to avoid timezone shifting.
 * @param {Date} date - Date object
 * @returns {string} ISO date string (YYYY-MM-DD)
 */
function formatDateForAPI(date) {
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
function formatDateForDisplay(dateStr, locale) {
  if (!dateStr) return '';
  locale = locale || 'en';
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
function isValidDateRange(start, end) {
  if (!start || !end) return true; // partial range is considered valid
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return false;
  return endDate >= startDate;
}

// ---------------------------------------------------------------------------
// createDatePicker
// ---------------------------------------------------------------------------

/**
 * Create a date picker inside a container element.
 *
 * @param {HTMLElement} container - DOM element to render into
 * @param {object} [options]
 * @param {string} [options.label] - Label text
 * @param {string} [options.value] - Initial value (YYYY-MM-DD)
 * @param {string} [options.min] - Minimum date (YYYY-MM-DD)
 * @param {string} [options.max] - Maximum date (YYYY-MM-DD)
 * @param {boolean} [options.required] - Whether field is required
 * @param {boolean} [options.disabled] - Whether field is disabled
 * @param {function} [options.onChange] - Called with new value (YYYY-MM-DD)
 * @param {string} [options.id] - Input element id
 * @returns {object} API: { getValue, setValue, setError, clearError, getElement, setMin, setMax }
 */
function createDatePicker(container, options) {
  options = options || {};
  const id = options.id || 'dp-' + Math.random().toString(36).substr(2, 9);

  // Build DOM
  const wrapper = document.createElement('div');
  wrapper.className = 'dp-container';

  if (options.label) {
    const label = document.createElement('label');
    label.className = 'dp-label';
    label.htmlFor = id;
    label.textContent = options.label;
    if (options.required) {
      const req = document.createElement('span');
      req.className = 'dp-required';
      req.textContent = '*';
      label.appendChild(req);
    }
    wrapper.appendChild(label);
  }

  const input = document.createElement('input');
  input.type = 'date';
  input.id = id;
  input.className = 'dp-input';
  if (options.value) input.value = options.value;
  if (options.min) input.min = options.min;
  if (options.max) input.max = options.max;
  if (options.required) input.required = true;
  if (options.disabled) input.disabled = true;
  wrapper.appendChild(input);

  const errorEl = document.createElement('span');
  errorEl.className = 'dp-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  wrapper.appendChild(errorEl);

  input.addEventListener('change', function () {
    if (options.onChange) {
      options.onChange(input.value);
    }
  });

  container.appendChild(wrapper);

  // Public API
  return {
    getValue: function () { return input.value; },
    setValue: function (v) { input.value = v || ''; },
    setError: function (msg) {
      input.classList.add('dp-input--error');
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    },
    clearError: function () {
      input.classList.remove('dp-input--error');
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    },
    getElement: function () { return wrapper; },
    setMin: function (v) { input.min = v || ''; },
    setMax: function (v) { input.max = v || ''; },
  };
}

// ---------------------------------------------------------------------------
// createDateRangePicker
// ---------------------------------------------------------------------------

/**
 * Create a date range picker (start + end) with validation.
 *
 * @param {HTMLElement} container - DOM element to render into
 * @param {object} [options]
 * @param {string} [options.startLabel] - Label for start date (default: "Start Date")
 * @param {string} [options.endLabel] - Label for end date (default: "End Date")
 * @param {string} [options.startValue] - Initial start date (YYYY-MM-DD)
 * @param {string} [options.endValue] - Initial end date (YYYY-MM-DD)
 * @param {string} [options.min] - Minimum date for both inputs
 * @param {string} [options.max] - Maximum date for both inputs
 * @param {boolean} [options.required] - Whether both fields are required
 * @param {boolean} [options.disabled] - Whether both fields are disabled
 * @param {function} [options.onChange] - Called with { start, end } on any change
 * @returns {object} API: { getValues, setValues, getElement }
 */
function createDateRangePicker(container, options) {
  options = options || {};

  const wrapper = document.createElement('div');
  wrapper.className = 'dp-range';

  const startField = document.createElement('div');
  startField.className = 'dp-range__field';

  const separator = document.createElement('div');
  separator.className = 'dp-range__separator';
  separator.textContent = 'to';

  const endField = document.createElement('div');
  endField.className = 'dp-range__field';

  wrapper.appendChild(startField);
  wrapper.appendChild(separator);
  wrapper.appendChild(endField);

  function validate() {
    const start = startPicker.getValue();
    const end = endPicker.getValue();
    if (!isValidDateRange(start, end)) {
      endPicker.setError('End date must be on or after start date');
    } else {
      endPicker.clearError();
    }
  }

  function handleChange() {
    // Constrain: end min = start, start max = end
    startPicker.setMax(endPicker.getValue() || options.max || '');
    endPicker.setMin(startPicker.getValue() || options.min || '');
    validate();
    if (options.onChange) {
      options.onChange({
        start: startPicker.getValue(),
        end: endPicker.getValue(),
      });
    }
  }

  var startPicker = createDatePicker(startField, {
    label: options.startLabel || 'Start Date',
    value: options.startValue,
    min: options.min,
    max: options.endValue || options.max,
    required: options.required,
    disabled: options.disabled,
    onChange: handleChange,
  });

  var endPicker = createDatePicker(endField, {
    label: options.endLabel || 'End Date',
    value: options.endValue,
    min: options.startValue || options.min,
    max: options.max,
    required: options.required,
    disabled: options.disabled,
    onChange: handleChange,
  });

  container.appendChild(wrapper);

  return {
    getValues: function () {
      return { start: startPicker.getValue(), end: endPicker.getValue() };
    },
    setValues: function (start, end) {
      startPicker.setValue(start);
      endPicker.setValue(end);
      handleChange();
    },
    getElement: function () { return wrapper; },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createDatePicker,
    createDateRangePicker,
    injectDatePickerStyles,
    DATE_PICKER_CSS,
    formatDateForAPI,
    formatDateForDisplay,
    isValidDateRange,
  };
}
