/**
 * scopes: [frontend]
 * flags: []
 * description: React date picker (TypeScript + Tailwind) using native <input type="date">.
 */

/**
 * React DatePicker Components (TypeScript + Tailwind)
 *
 * Date picker and date range picker components using native <input type="date">.
 * Uses Tailwind utility classes — no external CSS dependency. Controlled
 * components with value/onChange, min/max, label, required, disabled props.
 *
 * Dependencies: React 18+.
 *
 * Usage:
 *   import {
 *     DatePicker, DateRangePicker,
 *     formatDateForAPI, formatDateForDisplay, isValidDateRange,
 *   } from './datepicker-react.js';
 *
 *   const [date, setDate] = useState('');
 *   <DatePicker label="Start Date" value={date} onChange={setDate} required />
 *
 *   const [start, setStart] = useState('');
 *   const [end, setEnd] = useState('');
 *   <DateRangePicker
 *     startValue={start} endValue={end}
 *     onStartChange={setStart} onEndChange={setEnd}
 *   />
 *
 *   formatDateForAPI(new Date());              // "2024-01-15"
 *   formatDateForDisplay('2024-01-15', 'de');  // "15. Januar 2024"
 *   isValidDateRange('2024-01-01', '2024-12-31'); // true
 *
 * Common pitfalls:
 *   1. Always use YYYY-MM-DD format for API calls.
 *   2. new Date('2024-01-15') creates UTC midnight; in negative UTC offsets
 *      this displays as the PREVIOUS day. Use 'YYYY-MM-DDT00:00:00' to force
 *      local timezone.
 *   3. Don't store dates as display strings; store ISO 8601 and format on display.
 */

import * as React from 'react';
import { cn } from '../frontend/lib/utils.js';

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Format a Date object to ISO 8601 date string (YYYY-MM-DD) for API calls.
 * Uses local date components to avoid timezone shifting.
 */
export function formatDateForAPI(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a YYYY-MM-DD date string for display in the user's locale.
 */
export function formatDateForDisplay(
  dateStr: string,
  locale: string = 'en'
): string {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Validate that a date range is valid (end >= start).
 * Partial ranges (one side missing) are considered valid.
 */
export function isValidDateRange(start: string, end: string): boolean {
  if (!start || !end) return true;
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return false;
  }
  return endDate >= startDate;
}

// ---------------------------------------------------------------------------
// DatePicker
// ---------------------------------------------------------------------------

export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  id?: string;
  className?: string;
}

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
  className,
}: DatePickerProps): React.JSX.Element {
  const autoId = React.useId();
  const inputId = id || autoId;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-slate-700"
        >
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      <input
        id={inputId}
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        required={required}
        disabled={disabled}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className={cn(
          'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20',
          disabled && 'cursor-not-allowed bg-slate-100 text-slate-400',
          error && 'border-red-500'
        )}
      />
      {error && (
        <span
          id={`${inputId}-error`}
          role="alert"
          className="text-xs text-red-500"
        >
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateRangePicker
// ---------------------------------------------------------------------------

export interface DateRangePickerProps {
  startValue: string;
  endValue: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  startLabel?: string;
  endLabel?: string;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

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
  className,
}: DateRangePickerProps): React.JSX.Element {
  const rangeValid = isValidDateRange(startValue, endValue);
  const rangeError = !rangeValid
    ? 'End date must be on or after start date'
    : undefined;

  return (
    <div className={cn('flex items-start gap-4', className)}>
      <div className="flex-1">
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
      <div className="pt-7 text-sm text-slate-500">to</div>
      <div className="flex-1">
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
