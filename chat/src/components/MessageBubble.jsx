import { useState, useRef, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyIcon, CheckIcon } from './Icon.jsx';
import { timeAgo } from '../lib/time.js';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy} aria-label="Copy code">
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ children }) {
  const codeRef = useRef(null);
  const text = String(children?.props?.children || '').replace(/\n$/, '');
  const lang = (children?.props?.className || '').replace('language-', '');
  const isLong = text.split('\n').length > 8;

  useEffect(() => {
    if (codeRef.current && window.hljs) {
      window.hljs.highlightElement(codeRef.current);
    }
  }, [text]);

  if (isLong) {
    return (
      <div className="code-block-wrapper">
        <CopyButton text={text} />
        <details className="technical-block">
          <summary>{lang || 'Code'} ({text.split('\n').length} lines — click to expand)</summary>
          <pre>
            <code ref={codeRef} className={lang ? `language-${lang}` : ''}>
              {text}
            </code>
          </pre>
        </details>
      </div>
    );
  }

  return (
    <div className="code-block-wrapper">
      <CopyButton text={text} />
      <pre className="code-small">
        <code ref={codeRef} className={lang ? `language-${lang}` : ''}>
          {text}
        </code>
      </pre>
    </div>
  );
}

const markdownComponents = {
  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
};

function MarkdownText({ text }) {
  if (!text?.trim()) return null;
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </Markdown>
  );
}

function FileNotification({ text }) {
  try {
    const info = JSON.parse(text);
    if (info.tool === 'write_to_file' || info.tool === 'replace_in_file') {
      const parts = (info.path || '').split('/');
      const shortPath = parts.length > 2 ? parts.slice(-2).join('/') : info.path;
      const action = info.tool === 'write_to_file' ? 'created' : 'modified';
      return (
        <div className="file-notification">
          <span className="file-icon">{action === 'created' ? '+' : '~'}</span>
          <span className="file-path">{shortPath}</span>
          <span className="file-action">{action}</span>
        </div>
      );
    }
    if (['read_file', 'list_files', 'search_files', 'list_code_definition_names'].includes(info.tool)) {
      return null;
    }
    return (
      <div className="bubble bubble-system">
        <details className="technical-block">
          <summary>{info.tool}: {info.path || ''} (expand)</summary>
          <pre>{info.content || text}</pre>
        </details>
      </div>
    );
  } catch {
    return (
      <div className="bubble bubble-system">
        <details className="technical-block">
          <summary>Tool operation (expand)</summary>
          <pre>{text}</pre>
        </details>
      </div>
    );
  }
}

export default function MessageBubble({ type, payload }) {
  const ts = payload?.ts;

  if (type === 'user') {
    if (payload.source === 'system') return null;
    return (
      <div className="bubble bubble-user">
        <div className="bubble-content">{payload.message}</div>
        {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
      </div>
    );
  }

  if (type === 'cline') {
    const { say, ask, text } = payload;

    if (say === 'text' || say === 'completion_result') {
      if (!text?.trim()) return null;
      return (
        <div className="bubble bubble-assistant">
          <div className="bubble-content markdown-body">
            <MarkdownText text={text} />
          </div>
          {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
        </div>
      );
    }

    if (say === 'command') {
      return (
        <div className="bubble bubble-system">
          <details className="technical-block">
            <summary>Command executed (expand)</summary>
            <pre>{`$ ${text}`}</pre>
          </details>
        </div>
      );
    }

    if (say === 'tool') {
      return <FileNotification text={text} />;
    }

    if (say === 'task_progress') {
      return (
        <div className="bubble bubble-progress">
          <div className="bubble-content markdown-body">
            <MarkdownText text={text} />
          </div>
        </div>
      );
    }

    if (ask === 'command_output') {
      if (!text?.trim()) return null;
      return (
        <div className="bubble bubble-system">
          <details className="technical-block">
            <summary>Command output (expand)</summary>
            <pre>{text}</pre>
          </details>
        </div>
      );
    }

    return null;
  }

  if (type === 'stdout') {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!text.trim()) return null;
    return (
      <div className="bubble bubble-assistant">
        <div className="bubble-content markdown-body">
          <MarkdownText text={text} />
        </div>
      </div>
    );
  }

  return null;
}
