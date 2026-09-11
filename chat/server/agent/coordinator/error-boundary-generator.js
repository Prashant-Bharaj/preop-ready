/**
 * error-boundary-generator.js — emits the pre-staged React error boundary as
 * `frontend/src/generated/ErrorBoundary.tsx`.
 *
 * A rendering exception in generated UI code previously produced a BLANK
 * PAGE (observed live: a list component reading renamed fields crashed on
 * undefined). The boundary turns that into a readable error card the user
 * can paste into the chat — which is also exactly what the diagnose loop
 * needs to fix it in one round.
 *
 * The subagent only has to WRAP its app content: one import + one JSX tag.
 */

export function generateErrorBoundary(apiContract) {
  const endpoints = Array.isArray(apiContract?.endpoints) ? apiContract.endpoints : [];
  if (endpoints.length === 0) return null;

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — pre-staged error boundary.`);
  lines.push(`// Wrap your app content: import ErrorBoundary from './generated/ErrorBoundary.js';`);
  lines.push(`// A render crash shows a readable error card instead of a blank page.`);
  lines.push('');
  lines.push(`import { Component } from 'react';`);
  lines.push(`import type { ReactNode, ErrorInfo } from 'react';`);
  lines.push('');
  lines.push(`interface Props { children: ReactNode; }`);
  lines.push(`interface State { error: Error | null; }`);
  lines.push('');
  lines.push(`export default class ErrorBoundary extends Component<Props, State> {`);
  lines.push(`  state: State = { error: null };`);
  lines.push('');
  lines.push(`  static getDerivedStateFromError(error: Error): State {`);
  lines.push(`    return { error };`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  componentDidCatch(error: Error, info: ErrorInfo): void {`);
  lines.push(`    console.error('Render error caught by ErrorBoundary:', error, info.componentStack);`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  render(): ReactNode {`);
  lines.push(`    if (!this.state.error) return this.props.children;`);
  lines.push(`    return (`);
  lines.push(`      <div style={{ maxWidth: 640, margin: '4rem auto', padding: '1.5rem', border: '1px solid #fca5a5', borderRadius: 8, background: '#fef2f2', fontFamily: 'system-ui, sans-serif' }}>`);
  lines.push(`        <h2 style={{ margin: '0 0 0.5rem', color: '#b91c1c', fontSize: 18 }}>Something went wrong on this page</h2>`);
  lines.push(`        <p style={{ margin: '0 0 0.75rem', color: '#7f1d1d', fontSize: 14 }}>`);
  lines.push(`          The page hit a rendering error. Copy the message below into the assistant chat and it can fix it.`);
  lines.push(`        </p>`);
  lines.push(`        <pre style={{ whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #fecaca', borderRadius: 6, padding: '0.75rem', fontSize: 12, color: '#991b1b' }}>`);
  lines.push(`          {String(this.state.error?.message || this.state.error)}`);
  lines.push(`        </pre>`);
  lines.push(`        <button`);
  lines.push(`          style={{ marginTop: '0.75rem', padding: '0.4rem 0.9rem', border: '1px solid #b91c1c', borderRadius: 6, background: 'transparent', color: '#b91c1c', cursor: 'pointer' }}`);
  lines.push(`          onClick={() => window.location.reload()}`);
  lines.push(`        >`);
  lines.push(`          Reload page`);
  lines.push(`        </button>`);
  lines.push(`      </div>`);
  lines.push(`    );`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');
  return { source: lines.join('\n') };
}
