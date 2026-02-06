import { useState } from 'react';

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const DIFF_LINE_RE = /^(\+\+\+|---|@@).*$/gm;

function containsTechnicalContent(text) {
  CODE_FENCE_RE.lastIndex = 0;
  DIFF_LINE_RE.lastIndex = 0;
  return CODE_FENCE_RE.test(text) || DIFF_LINE_RE.test(text);
}

function splitContent(text) {
  const segments = [];
  let lastIdx = 0;

  for (const match of text.matchAll(/```[\s\S]*?```/g)) {
    if (match.index > lastIdx) {
      segments.push({ type: 'text', content: text.slice(lastIdx, match.index) });
    }
    segments.push({ type: 'code', content: match[0] });
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    const remaining = text.slice(lastIdx);
    if (/^(\+\+\+|---|@@)/m.test(remaining)) {
      const lines = remaining.split('\n');
      let normalBuf = [];
      let diffBuf = [];
      let inDiff = false;

      for (const line of lines) {
        const isDiffLine = /^(\+\+\+|---|@@|\+[^+]|-[^-])/.test(line);
        if (isDiffLine) {
          if (!inDiff && normalBuf.length) {
            segments.push({ type: 'text', content: normalBuf.join('\n') });
            normalBuf = [];
          }
          inDiff = true;
          diffBuf.push(line);
        } else {
          if (inDiff && diffBuf.length) {
            segments.push({ type: 'code', content: diffBuf.join('\n') });
            diffBuf = [];
          }
          inDiff = false;
          normalBuf.push(line);
        }
      }
      if (diffBuf.length) segments.push({ type: 'code', content: diffBuf.join('\n') });
      if (normalBuf.length) segments.push({ type: 'text', content: normalBuf.join('\n') });
    } else {
      segments.push({ type: 'text', content: remaining });
    }
  }

  return segments;
}

function TechnicalBlock({ content, label }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="technical-block" open={expanded} onToggle={(e) => setExpanded(e.target.open)}>
      <summary>{label || 'Technical output (expand)'}</summary>
      <pre>{content}</pre>
    </details>
  );
}

function AssistantText({ text }) {
  if (!text?.trim()) return null;

  if (containsTechnicalContent(text)) {
    const segments = splitContent(text);
    return (
      <div className="bubble bubble-assistant">
        <div className="bubble-content">
          {segments.map((seg, i) =>
            seg.type === 'code'
              ? <TechnicalBlock key={i} content={seg.content} />
              : <span key={i}>{seg.content}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bubble bubble-assistant">
      <div className="bubble-content">{text}</div>
    </div>
  );
}

export default function MessageBubble({ type, payload }) {
  // User messages
  if (type === 'user') {
    if (payload.source === 'system') return null; // hide bootstrap prompt
    return (
      <div className="bubble bubble-user">
        <div className="bubble-content">{payload.message}</div>
      </div>
    );
  }

  // Structured Cline JSON events
  if (type === 'cline') {
    const { say, ask, text } = payload;

    // Assistant text response (main content the user sees)
    if (say === 'text' || say === 'completion_result') {
      return <AssistantText text={text} />;
    }

    // Command being executed
    if (say === 'command') {
      return (
        <div className="bubble bubble-system">
          <TechnicalBlock content={`$ ${text}`} label="Command executed (expand)" />
        </div>
      );
    }

    // Tool use (file read/write/etc.)
    if (say === 'tool') {
      let label = 'Tool operation (expand)';
      let content = text;
      try {
        const toolInfo = JSON.parse(text);
        label = `${toolInfo.tool}: ${toolInfo.path || ''} (expand)`;
        content = toolInfo.content || text;
      } catch { /* use raw text */ }
      return (
        <div className="bubble bubble-system">
          <TechnicalBlock content={content} label={label} />
        </div>
      );
    }

    // Task progress
    if (say === 'task_progress') {
      return (
        <div className="bubble bubble-progress">
          <div className="bubble-content">{text}</div>
        </div>
      );
    }

    // Command output
    if (ask === 'command_output') {
      if (!text?.trim()) return null;
      return (
        <div className="bubble bubble-system">
          <TechnicalBlock content={text} label="Command output (expand)" />
        </div>
      );
    }

    // Skip noisy internal events (task echo, api_req_started, etc.)
    return null;
  }

  // Legacy raw stdout fallback (non-JSON lines from Cline)
  if (type === 'stdout') {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!text.trim()) return null;
    return (
      <div className="bubble bubble-assistant">
        <div className="bubble-content">{text}</div>
      </div>
    );
  }

  // Session status
  if (type === 'status') {
    return <div className="bubble bubble-status">Status: {payload.status}</div>;
  }

  return null;
}
