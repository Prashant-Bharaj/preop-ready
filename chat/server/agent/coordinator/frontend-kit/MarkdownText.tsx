/**
 * Dependency-free markdown renderer for AI-generated text. Covers the subset
 * LLM answers actually use: headings, bold, italic, inline code, code fences,
 * links, ordered/unordered lists, paragraphs. Render EVERY AI answer through
 * this — literal **asterisks** on screen is a visual-check defect.
 */
import type { ReactNode } from 'react';

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2]) out.push(<strong key={`${keyBase}-${i++}`}>{m[2]}</strong>);
    else if (m[4]) out.push(<em key={`${keyBase}-${i++}`}>{m[4]}</em>);
    else if (m[6]) out.push(<code key={`${keyBase}-${i++}`} style={{ fontFamily: 'var(--kit-mono)', fontSize: '0.9em', background: 'var(--kit-bg)', padding: '1px 5px', borderRadius: 4 }}>{m[6]}</code>);
    else if (m[8]) out.push(<a key={`${keyBase}-${i++}`} href={m[9]} target="_blank" rel="noopener noreferrer">{m[8]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = (text || '').split('\n');
  let i = 0; let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={key++} style={{ fontFamily: 'var(--kit-mono)', fontSize: 13, background: 'var(--kit-bg)', border: '1px solid var(--kit-border)', borderRadius: 'var(--kit-radius-sm)', padding: 12, overflowX: 'auto' }}>{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(<div key={key++} style={{ fontWeight: 700, fontSize: 18 - level, margin: '12px 0 4px' }}>{inline(h[2], `h${key}`)}</div>);
      i++; continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = []; const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++;
      }
      const Li = items.map((it, j) => <li key={j} style={{ margin: '2px 0' }}>{inline(it, `li${key}-${j}`)}</li>);
      blocks.push(ordered
        ? <ol key={key++} style={{ margin: '6px 0', paddingLeft: 22 }}>{Li}</ol>
        : <ul key={key++} style={{ margin: '6px 0', paddingLeft: 22 }}>{Li}</ul>);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4})\s|^```|^\s*([-*]|\d+\.)\s/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push(<p key={key++} style={{ margin: '6px 0', lineHeight: 1.55 }}>{inline(buf.join(' '), `p${key}`)}</p>);
  }
  return <div style={{ fontSize: 14 }}>{blocks}</div>;
}
