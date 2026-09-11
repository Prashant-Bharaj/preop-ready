import { useState, useRef, useEffect, memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyIcon, CheckIcon, BranchIcon } from './Icon.jsx';
import { timeAgo } from '../lib/time.js';

/**
 * Direct-action "branch from here" button rendered on user-message bubbles.
 * Single click → parent's onBranch → the confirmation modal in ChatScreen.
 */
function BranchButton({ onBranch }) {
  return (
    <button
      type="button"
      className="bubble-branch-btn"
      aria-label="Branch a new conversation from this message"
      title="Branch from here"
      onClick={(e) => { e.stopPropagation(); onBranch(); }}
    >
      <BranchIcon size={12} />
    </button>
  );
}

/**
 * Parse clarification text into question groups with selectable options.
 * Detects patterns like:
 *   "Contact form — choose one: A) option one. B) option two."
 *   or multiline with A), B), C) on separate lines.
 *
 * Normalises two formats that used to break the regex:
 *   - Markdown-bold markers: **A)** / *A)* / __A)__ — strip the emphasis.
 *   - Options on separate lines (A)\nB)\nC)) — fold onto the previous line so
 *     the single-line detector below still picks up A) AND B) together.
 */
function parseClarificationOptions(text) {
  if (!text || !text.includes(')')) return [];

  const normalised = text
    .replace(/[*_]+/g, '')                   // drop markdown emphasis
    .replace(/\n(?=\s*[A-D]\))/g, ' ');      // join per-line options into one line

  const groups = [];
  const lines = normalised.split('\n').filter(l => l.trim());

  // Accumulate non-option lines as preamble
  let preamble = [];

  for (const line of lines) {
    // Option markers must be preceded by whitespace or start-of-line (not "DB)" or "AB)")
    // Use word-boundary-safe pattern: (^|\s)A) ... (^|\s)B)
    if (!/(^|\s)A\)/.test(line) || !/(^|\s)B\)/.test(line)) {
      preamble.push(line);
      continue;
    }

    // Find start of first A) marker (word-boundary safe)
    const aMatch = line.match(/(^|\s)A\)/);
    if (!aMatch) { preamble.push(line); continue; }
    const aIdx = aMatch.index + aMatch[1].length; // skip the leading space

    const questionPart = line.substring(0, aIdx).trim()
      .replace(/[\s:—\-]+$/g, '')
      .replace(/\s*choose\s+one\s*$/i, '')
      .trim();

    const optionsPart = line.substring(aIdx);

    // Find each option start position — require whitespace or start before the letter
    const markers = [...optionsPart.matchAll(/(^|(?<=\s))([A-D])\)\s*/g)];
    if (markers.length < 2) continue;

    const options = markers.map((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < markers.length ? markers[i + 1].index : optionsPart.length;
      return {
        label: m[2],
        text: optionsPart.substring(start, end).trim().replace(/\.\s*$/, '').replace(/\s+OR\s*$/i, ''),
      };
    });

    groups.push({ question: questionPart || preamble.pop() || '', options });
  }

  // Store any remaining preamble on the first group
  if (groups.length > 0 && preamble.length > 0) {
    groups[0].preamble = preamble.join('\n');
  }

  return groups;
}

// Build ClarificationButtons `groups` from a structured `questions[]` payload
// (planner/concierge). Returns null when there's nothing usable so the caller
// can fall back to prose parsing. Mirrors the normalizer in two-agent.js.
function structuredGroupsFromQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) return null;
  const groups = questions
    .filter(q => q && q.text && Array.isArray(q.options) && q.options.length >= 2)
    .map(q => ({
      question: q.text,
      options: q.options.map(o => ({ label: o.label, text: o.text })),
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther !== false,
    }));
  return groups.length ? groups : null;
}

// A question is multi-select when phrased as "pick any / select all that apply /
// choose any / one or more". Single-select ("which is closest?") stays radio-style.
// Fallback only — structured questions carry an explicit `multiSelect` flag.
function isMultiSelectGroup(group) {
  const t = `${group?.question || ''} ${group?.preamble || ''}`.toLowerCase();
  return /(pick|select|choose|check)\s+(any|all)|all that apply|one or more|any that/.test(t);
}

function ClarificationButtons({ groups, onSendMessage, onClarifyActive, readOnly = false }) {
  // selections[qi] is an ARRAY of chosen labels (['A','C'] or ['other']) so a
  // single question can hold multiple answers when it's a multi-select group.
  const [selections, setSelections] = useState({});
  const [customTexts, setCustomTexts] = useState({});
  const [extraContext, setExtraContext] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [currentTab, setCurrentTab] = useState(0);
  const customInputRefs = useRef({});
  const extraInputRef = useRef(null);

  // Total tab count — in read-only mode we drop the "+" extra step (nothing
  // to type in a past card). Live cards get one per question plus the extras.
  const totalTabs = readOnly ? groups.length : groups.length + 1;
  const isExtraTab = !readOnly && currentTab === groups.length;

  useEffect(() => {
    // Read-only cards are rendered from history and have no active input —
    // don't touch the composer-hide counter or history would permanently
    // suppress the composer.
    if (readOnly || !onClarifyActive) return;
    onClarifyActive(!submitted);
    return () => onClarifyActive(false);
  }, [submitted, onClarifyActive, readOnly]);

  function isAnswered(qi) {
    const sel = selections[qi] || [];
    const hasReal = sel.some(s => s !== 'other');
    const hasOtherText = sel.includes('other') && (customTexts[qi] || '').trim().length > 0;
    return hasReal || hasOtherText;
  }

  if (submitted) {
    return (
      <div className="clarification-options submitted">
        {groups.map((group, gi) => {
          const sel = selections[gi] || [];
          const otherText = sel.includes('other') ? (customTexts[gi] || '').trim() : '';
          return (
            <div key={gi} className="answer-item">
              <span className="answer-question">{group.question}</span>
              {/* Show every option that was offered, with the chosen one(s)
                  highlighted — so the answered question still shows what the
                  user picked FROM, not just the result. */}
              <div className="answer-options">
                {group.options.map(opt => (
                  <span
                    key={opt.label}
                    className={`answer-option${sel.includes(opt.label) ? ' chosen' : ''}`}
                  >
                    <span className="answer-label">{opt.label}</span>
                    <span className="answer-option-text">{opt.text}</span>
                  </span>
                ))}
                {otherText && (
                  <span className="answer-option chosen">
                    <span className="answer-label">+</span>
                    <span className="answer-option-text">{otherText}</span>
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {extraContext.trim() && (
          <div className="answer-item">
            <span className="answer-question">Additional context</span>
            <span className="answer-choice">{extraContext.trim()}</span>
          </div>
        )}
      </div>
    );
  }

  function handleSelect(qi, label, multi) {
    setSelections(prev => {
      const cur = prev[qi] || [];
      if (multi) {
        // Toggle membership — multiple options can be active at once.
        const next = cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label];
        return { ...prev, [qi]: next };
      }
      // Single-select — replace.
      return { ...prev, [qi]: [label] };
    });
    if (label === 'other') {
      // Keep user on the same tab so they can type. Focus the textarea.
      setTimeout(() => customInputRefs.current[qi]?.focus(), 0);
      return;
    }
    // Single-select auto-advances so the wizard feels quick; multi-select stays
    // put so the user can pick several before moving on.
    if (!multi) {
      setTimeout(() => {
        setCurrentTab((cur) => (cur === qi && cur < totalTabs - 1 ? cur + 1 : cur));
      }, 220);
    }
  }

  function handleCustomText(qi, text) {
    setCustomTexts(prev => ({ ...prev, [qi]: text }));
    if (text.trim()) {
      setSelections(prev => ((prev[qi] || []).includes('other')
        ? prev
        : { ...prev, [qi]: [...(prev[qi] || []), 'other'] }));
    }
  }

  function goToTab(i) {
    if (i < 0 || i >= totalTabs) return;
    setCurrentTab(i);
    if (i === totalTabs - 1) {
      setTimeout(() => extraInputRef.current?.focus(), 0);
    } else if ((selections[i] || []).includes('other')) {
      setTimeout(() => customInputRefs.current[i]?.focus(), 0);
    }
  }

  function handleSubmit() {
    const parts = groups.map((g, i) => {
      const sel = selections[i] || [];
      if (sel.length === 0) return null;
      const chosen = [];
      for (const label of sel) {
        if (label === 'other') {
          const custom = (customTexts[i] || '').trim();
          if (custom) chosen.push(custom);
        } else {
          const opt = g.options.find(o => o.label === label);
          if (opt) chosen.push(`${label}) ${opt.text}`);
        }
      }
      if (chosen.length === 0) return null;
      return `${g.question}: ${chosen.join(', ')}`;
    }).filter(Boolean);

    const extra = extraContext.trim();
    if (extra) parts.push(`Additional context: ${extra}`);

    if (parts.length > 0 && onSendMessage) {
      setSubmitted(true);
      onSendMessage('My answers to your questions:\n' + parts.join('\n'));
    }
  }

  const allAnswered = groups.every((_, i) => isAnswered(i));
  const canGoNext = isExtraTab ? false : isAnswered(currentTab);

  const group = !isExtraTab ? groups[currentTab] : null;
  // Explicit per-question flag wins; phrase-sniffing stays only as the fallback
  // for prose-parsed (legacy) groups that carry no multiSelect field.
  const multi = group ? (group.multiSelect ?? isMultiSelectGroup(group)) : false;
  // Structured questions can opt out of the free-text escape hatch (allowOther:false).
  // Prose-parsed groups have no flag → keep the historical always-on behavior.
  const allowOther = group ? (group.allowOther !== false) : true;
  const otherLabel = group ? String.fromCharCode('A'.charCodeAt(0) + group.options.length) : null;
  const curSelected = selections[currentTab] || [];
  const isOtherSelected = !isExtraTab && allowOther && curSelected.includes('other');

  return (
    <div className="clarification-options">
      {groups[0]?.preamble && currentTab === 0 && (
        <p className="clarification-preamble">{groups[0].preamble}</p>
      )}

      <div className="clarification-tabs" role="tablist">
        {groups.map((_, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={currentTab === i}
            className={`clarification-tab${currentTab === i ? ' active' : ''}${isAnswered(i) ? ' answered' : ''}`}
            onClick={() => goToTab(i)}
          >
            <span className="clarification-tab-num">{i + 1}</span>
            {isAnswered(i) && <span className="clarification-tab-check" aria-hidden>✓</span>}
          </button>
        ))}
        {!readOnly && (
          <button
            role="tab"
            aria-selected={isExtraTab}
            className={`clarification-tab clarification-tab-extra${isExtraTab ? ' active' : ''}${extraContext.trim() ? ' answered' : ''}`}
            onClick={() => goToTab(groups.length)}
          >
            <span className="clarification-tab-num">+</span>
          </button>
        )}
      </div>

      {!isExtraTab ? (
        <div className="clarification-group">
          <p className="clarification-question">
            <span className="clarification-step-marker">Question {currentTab + 1} of {groups.length}</span>
            {group.question}
            {multi && <span className="clarification-multi-hint">select all that apply</span>}
          </p>
          {readOnly ? (
            // Read-only: render options as a static list matching the live
            // card's button row, but not clickable. Preserves the tabbed
            // visual style for past clarifies without re-wiring selection.
            <div className="clarification-buttons clarification-buttons-readonly">
              {group.options.map(opt => (
                <div key={opt.label} className="clarification-btn clarification-btn-readonly">
                  <span className="option-label">{opt.label}</span>
                  <span className="option-text">{opt.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className={`clarification-buttons${multi ? ' clarification-buttons-multi' : ''}`}>
              {group.options.map(opt => (
                <button
                  key={opt.label}
                  className={`clarification-btn ${curSelected.includes(opt.label) ? 'selected' : ''}`}
                  onClick={() => handleSelect(currentTab, opt.label, multi)}
                >
                  <span className="option-label">{opt.label}</span>
                  <span className="option-text">{opt.text}</span>
                </button>
              ))}
              {allowOther && (
                <button
                  key="other"
                  className={`clarification-btn clarification-btn-other ${isOtherSelected ? 'selected' : ''}`}
                  onClick={() => handleSelect(currentTab, 'other', multi)}
                >
                  <span className="option-label">{otherLabel}</span>
                  <span className="option-text">Other — type your own answer</span>
                </button>
              )}
            </div>
          )}
          {!readOnly && isOtherSelected && (
            <textarea
              ref={(el) => { customInputRefs.current[currentTab] = el; }}
              className="clarification-custom-input"
              value={customTexts[currentTab] || ''}
              onChange={(e) => handleCustomText(currentTab, e.target.value)}
              placeholder="Tell us more about this in your own words..."
              rows={2}
            />
          )}
        </div>
      ) : (
        <div className="clarification-extra">
          <label className="clarification-extra-label">Anything else to add? (optional)</label>
          <textarea
            ref={extraInputRef}
            className="clarification-custom-input"
            value={extraContext}
            onChange={(e) => setExtraContext(e.target.value)}
            placeholder="Any other context that would help…"
            rows={3}
          />
        </div>
      )}

      {readOnly ? (
        // Read-only nav: just Back/Next arrows to browse past questions.
        <div className="clarification-nav">
          <button
            type="button"
            className="clarification-nav-btn"
            onClick={() => goToTab(currentTab - 1)}
            disabled={currentTab === 0}
          >
            ← Back
          </button>
          <button
            type="button"
            className="clarification-nav-btn clarification-nav-next"
            onClick={() => goToTab(currentTab + 1)}
            disabled={currentTab >= totalTabs - 1}
          >
            Next →
          </button>
        </div>
      ) : (
        <div className="clarification-nav">
          <button
            type="button"
            className="clarification-nav-btn"
            onClick={() => goToTab(currentTab - 1)}
            disabled={currentTab === 0}
          >
            ← Back
          </button>
          {isExtraTab ? (
            <button
              type="button"
              className="clarification-submit"
              onClick={handleSubmit}
              disabled={!allAnswered}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="clarification-nav-btn clarification-nav-next"
              onClick={() => goToTab(currentTab + 1)}
              disabled={!canGoNext}
            >
              Next →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Strip AI-generated report boilerplate markers that add visual noise without
 * adding information. The AI prompt asks for structured reports and sometimes
 * emits these delimiters — harmless in a terminal, ugly in a rendered bubble.
 */
function stripReportMarkers(text) {
  if (!text) return text;
  return text
    // Lines that are ONLY "END REPORT" / "--- END REPORT ---" variants
    .replace(/^\s*-{2,}\s*END\s+REPORT\s*-{2,}\s*$/gim, '')
    .replace(/^\s*END\s+REPORT\s*$/gim, '')
    .replace(/^\s*#{1,3}\s*END\s+REPORT\s*$/gim, '')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip ANSI escape sequences and resolve \r-overwrites (e.g. docker-compose
 * progress spinners). Leaves normal text untouched.
 */
function cleanTerminalOutput(text) {
  if (!text) return '';
  // CSI sequences: ESC [ <params> <final-byte>
  // OSC sequences: ESC ] ... BEL
  const noAnsi = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  // Collapse \r-overwrites: keep only the last segment after a carriage return on each line.
  const resolved = noAnsi
    .split('\n')
    .map(line => {
      const parts = line.split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');
  // Trim trailing whitespace on each line so "empty" decorated lines disappear.
  return resolved.replace(/[ \t]+$/gm, '');
}

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

// Extensions we treat as "file paths" when Cline mentions them inline.
// Kept broad on purpose — anything with a real extension + a slash is clickable.
const FILE_PATH_EXT_RE = /\.(md|mdx|txt|json|ya?ml|toml|ini|env|sql|py|js|mjs|cjs|ts|tsx|jsx|vue|svelte|html?|css|scss|sass|less|sh|bash|zsh|rs|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|dockerfile|Dockerfile|lock)$/i;

/** Return true when a string looks like a repo-relative file path. */
function looksLikeFilePath(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 3 || t.length > 200) return false;
  if (/\s/.test(t)) return false;                          // paths don't have spaces
  if (t.startsWith('http://') || t.startsWith('https://')) return false;
  if (t.startsWith('/') || t.startsWith('~')) return false; // repo-relative only
  if (t.startsWith('.') && !t.startsWith('./')) return false; // .eslintrc ok via ./.eslintrc, reject bare dotfiles
  if (!t.includes('/')) {
    // Plain filename is fine if it has a real extension (Dockerfile, README.md…)
    return /^[A-Za-z0-9._-]+$/.test(t) && (FILE_PATH_EXT_RE.test(t) || t === 'Dockerfile' || t === 'Makefile');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(t)) return false;
  return FILE_PATH_EXT_RE.test(t) || /\/Dockerfile$/.test(t) || /\/Makefile$/.test(t);
}

/** Render a code span as a link to the raw file served by the backend. */
function FilePathLink({ path, className }) {
  const href = `/api/workspace-file?path=${encodeURIComponent(path)}`;
  return (
    <a
      className={`file-path-link ${className || ''}`.trim()}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${path}`}
    >
      {path}
    </a>
  );
}

const markdownComponents = {
  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
  // Inline <code>: if the content looks like a file path, render as a link.
  // Block code (inside <pre>) is handled by `pre` above — those children still
  // receive `inline: false` from react-markdown so we skip them here.
  code({ inline, className, children }) {
    const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
    if (inline !== false && looksLikeFilePath(raw)) {
      return <FilePathLink path={raw.trim()} className={className} />;
    }
    // Fall through to default — react-markdown will render a normal <code>.
    return <code className={className}>{children}</code>;
  },
  // All rendered links open in a new tab. In practice most of them are URLs
  // to the deployed app or platform pages — the user doesn't want their chat
  // session replaced when they click one.
  a({ href, children, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
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

/**
 * Renders the files a user attached to a message: images as inline thumbnails,
 * everything else as a compact pill-link that opens the raw file in a new tab.
 * Thumbnails/links resolve through GET /api/uploads/:name.
 */
function UploadAttachments({ uploads }) {
  return (
    <div className="message-attachments">
      {uploads.map((u, i) => {
        const mime = u.mime || '';
        const name = u.filename || '';
        const href = `/api/uploads/${encodeURIComponent(name)}`;
        if (mime.startsWith('image/')) {
          return (
            <a
              key={i}
              className="message-image-thumb"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={`${u.relativePath} — click to open`}
            >
              <img src={href} alt={name} loading="lazy" />
              <span className="message-image-thumb-name">{name}</span>
            </a>
          );
        }
        const sizeLabel = typeof u.size === 'number'
          ? (u.size >= 1024 * 1024 ? `${(u.size / (1024 * 1024)).toFixed(1)} MB` : u.size >= 1024 ? `${Math.round(u.size / 1024)} KB` : `${u.size} B`)
          : '';
        return (
          <a
            key={i}
            className="message-doc-link"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={u.parsed?.summary || u.relativePath}
          >
            <span className="message-doc-name">{name}</span>
            {sizeLabel && <span className="message-doc-size">{sizeLabel}</span>}
          </a>
        );
      })}
    </div>
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

function parseInvestigatorFindings(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"root_cause"')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.root_cause !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function MessageBubble({ type, payload, eventTs = null, onSendMessage, onClarifyActive, onBranch = null, isPastTurn = false }) {
  const ts = eventTs || payload?.ts;

  if (type === 'user') {
    if (payload.source === 'system') return null;
    const msg = payload.message || '';
    const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
    // Branch button only when the parent provides both a handler and the
    // event ts (needed to identify the turn on the backend).
    const branchMenu = (onBranch && eventTs)
      ? <BranchButton onBranch={() => onBranch(eventTs)} />
      : null;

    // Detect answer format and render as structured Q&A
    if (msg.startsWith('My answers to your questions:')) {
      const answerLines = msg.split('\n').slice(1).filter(l => l.trim());
      return (
        <div className="bubble bubble-user">
          {branchMenu}
          <div className="bubble-content answer-summary">
            <div className="answer-header">Your selections:</div>
            {answerLines.map((line, i) => {
              // Parse "Question: A) answer text"
              const match = line.match(/^(.+?):\s*([A-D])\)\s*(.+)$/);
              if (match) {
                return (
                  <div key={i} className="answer-item">
                    <span className="answer-question">{match[1]}</span>
                    <span className="answer-choice">
                      <span className="answer-label">{match[2]}</span>
                      {match[3]}
                    </span>
                  </div>
                );
              }
              return <div key={i} className="answer-item">{line}</div>;
            })}
          </div>
          {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
        </div>
      );
    }

    return (
      <div className="bubble bubble-user">
        {branchMenu}
        <div className="bubble-content">{msg}</div>
        {uploads.length > 0 && <UploadAttachments uploads={uploads} />}
        {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
      </div>
    );
  }

  if (type === 'concierge_text') {
    // Concierge replies. A `clarify` decision may carry structured questions —
    // render those as the same single/multi-select cards the planner uses. Plain
    // prose replies render as markdown (concierge prose is NOT A/B/C parsed —
    // only the explicit `questions` payload triggers a card).
    const text = (payload?.text || '').trim();
    const cgGroups = structuredGroupsFromQuestions(payload?.questions);
    if (cgGroups && onSendMessage) {
      if (text) cgGroups[0] = { ...cgGroups[0], preamble: text };
      if (isPastTurn) {
        return (
          <div className="bubble bubble-assistant">
            <div className="bubble-content"><ClarificationButtons groups={cgGroups} readOnly /></div>
            {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
          </div>
        );
      }
      return (
        <div className="bubble bubble-assistant">
          <div className="bubble-content">
            <ClarificationButtons groups={cgGroups} onSendMessage={onSendMessage} onClarifyActive={onClarifyActive} />
          </div>
          {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
        </div>
      );
    }
    if (!text) return null;
    return (
      <div className="bubble bubble-assistant">
        <div className="bubble-content markdown-body">
          <MarkdownText text={text} />
        </div>
        {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
      </div>
    );
  }

  if (type === 'cline') {
    const { say, ask, text } = payload;

    if (say === 'text' || say === 'completion_result') {
      const cleanedText = stripReportMarkers(text);
      if (!cleanedText?.trim()) return null;

      // Investigator findings arrive as raw JSON with a root_cause key —
      // developer-grade output in a user-facing surface. Render as a card.
      const findings = parseInvestigatorFindings(cleanedText);
      if (findings) {
        return (
          <div className="bubble bubble-assistant">
            <div className="bubble-content">
              <div className="findings-card">
                <div className="findings-card-header">
                  <span className="findings-card-title">Diagnosis</span>
                  {typeof findings.confidence === 'number' && (
                    <span className="findings-card-confidence">{Math.round(findings.confidence * 100)}% confident</span>
                  )}
                </div>
                <p className="findings-card-cause">{findings.root_cause}</p>
                {findings.recommended_fix?.description && (
                  <div className="findings-card-fix">
                    <span className="findings-card-fix-label">
                      Fix{findings.recommended_fix.scope ? ` (${findings.recommended_fix.scope})` : ''}
                    </span>
                    <p>{findings.recommended_fix.description}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      }

      // Prefer structured clarify questions from the planner when the event
      // carries them (explicit per-question multiSelect + allowOther). Fall back
      // to parsing the prose text (A/B/C style) for legacy / prose-only turns.
      const structured = structuredGroupsFromQuestions(payload.questions);
      // Keep the optional framing line (message) visible above the first card.
      if (structured && cleanedText?.trim()) {
        structured[0] = { ...structured[0], preamble: cleanedText.trim() };
      }
      const groups = structured || parseClarificationOptions(cleanedText);
      if (groups.length > 0 && onSendMessage) {
        // Past-turn clarify cards: render the SAME tab-wizard layout as the
        // live version, but read-only (no selection buttons, no Back/Next/
        // Continue, no composer-hide side-effects). Keeps the visual style
        // consistent across past and current turns and preserves the
        // question-by-question navigation the user expects.
        if (isPastTurn) {
          return (
            <div className="bubble bubble-assistant">
              <div className="bubble-content">
                <ClarificationButtons groups={groups} readOnly />
              </div>
              {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
            </div>
          );
        }
        return (
          <div className="bubble bubble-assistant">
            <div className="bubble-content">
              <ClarificationButtons groups={groups} onSendMessage={onSendMessage} onClarifyActive={onClarifyActive} />
            </div>
            {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
          </div>
        );
      }

      return (
        <div className="bubble bubble-assistant">
          <div className="bubble-content markdown-body">
            <MarkdownText text={cleanedText} />
          </div>
          {ts && <div className="bubble-timestamp">{timeAgo(ts)}</div>}
        </div>
      );
    }

    if (say === 'command') {
      const cmd = (text || '').trim();
      return (
        <div className="command-block">
          <span className="command-prompt">$</span>
          <span className="command-text">{cmd}</span>
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

    if (say === 'compacting') {
      // Rotation / context-window compaction in progress. Without this
      // indicator the user just sees a silent 10–15s stall while the
      // summarizer runs. Keep it visually distinct from chat bubbles —
      // a single-line system-event banner with a spinner.
      return (
        <div className="compacting-indicator" role="status" aria-live="polite">
          <span className="compacting-spinner" aria-hidden />
          <span className="compacting-text">{text || 'Compacting context…'}</span>
        </div>
      );
    }

    if (ask === 'api_req_failed') {
      // Cline payload: {"message":"402 status code","status":402,"modelId":"...","providerId":"..."}
      let info = { message: text || 'Unknown error', status: null, modelId: null, providerId: null };
      try { info = { ...info, ...JSON.parse(text || '{}') }; } catch { /* leave defaults */ }
      const statusHints = {
        401: 'Authentication failed — the API key may be invalid or expired.',
        402: 'The AI service returned 402 (payment required) — the account quota or billing for this model may be exhausted.',
        403: 'Access denied for this model or endpoint. Your key may not be authorised for this assistant or model.',
        404: 'The AI endpoint was not found. The service URL or model name may be wrong.',
        408: 'The request timed out. Try again; if it persists, the AI service may be slow.',
        429: 'Rate limit hit. Wait a moment and try again.',
        500: 'The AI service had an internal error. Try again in a minute.',
        502: 'The AI service is temporarily unreachable.',
        503: 'The AI service is unavailable. Try again shortly.',
      };
      const hint = (info.status && statusHints[info.status]) ||
        'The request did not reach the AI model. Check your VPN, credentials, or try again.';
      const title = info.status
        ? `AI service returned HTTP ${info.status}`
        : 'AI service error';
      return (
        <div className="bubble bubble-error api-error-bubble">
          <div className="api-error-icon" aria-hidden>⚠️</div>
          <div className="api-error-body">
            <div className="api-error-title">{title}</div>
            <div className="api-error-message">{info.message}</div>
            {info.modelId && (
              <div className="api-error-meta">
                <span className="api-error-meta-label">Model:</span>
                <code>{info.modelId}</code>
                {info.providerId && (
                  <>
                    <span className="api-error-meta-label"> · Provider:</span>
                    <code>{info.providerId}</code>
                  </>
                )}
              </div>
            )}
            <div className="api-error-hint">{hint}</div>
          </div>
        </div>
      );
    }

    if (ask === 'command_output') {
      const cleaned = cleanTerminalOutput(text).trim();
      if (!cleaned) return null;
      const lines = cleaned.split('\n').filter(l => l.trim().length > 0);
      // Drop blocks that are ALL whitespace/decorations after cleaning.
      if (lines.length === 0) return null;
      const lineCount = lines.length;
      const isLong = lineCount > 12;

      if (isLong) {
        // Show last few lines as preview, full output on expand
        const preview = lines.slice(-6).join('\n');
        return (
          <div className="command-output-block">
            <details className="technical-block">
              <summary>Output — {lineCount} lines (expand for full)</summary>
              <pre>{cleaned}</pre>
            </details>
            <pre className="command-output-preview">{preview}</pre>
          </div>
        );
      }

      return (
        <div className="command-output-block">
          <pre className="command-output-inline">{lines.join('\n')}</pre>
        </div>
      );
    }

    return null;
  }

  if (type === 'completion') {
    return (
      <div className="bubble bubble-assistant completion-summary">
        <div className="bubble-content">{payload.text}</div>
      </div>
    );
  }

  if (type === 'app_ready') {
    // Only the LATEST turn's app_ready renders as the live green banner. In
    // past turns it's a historical fact, not current state — during a fix
    // round the old banner sat next to "Verifying your app" claiming the app
    // was running while its containers were about to be rebuilt.
    if (isPastTurn) {
      return (
        <div className="bubble bubble-assistant app-ready-past">
          <div className="bubble-content">App was started here — current status is at the bottom of the chat.</div>
        </div>
      );
    }
    return (
      <div className="bubble bubble-assistant app-ready-card">
        <div className="bubble-content">
          <span className="app-ready-icon">&#x2705;</span>
          <span>Your app is running!</span>
          <a href={payload.url} target="_blank" rel="noopener noreferrer" className="app-ready-link">
            Open your app &rarr;
          </a>
        </div>
      </div>
    );
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

// Memoized: with stable props (payload ref + memoized handlers) a keystroke in
// the composer no longer re-renders every bubble's markdown — fixes post-build
// typing lag. Bubbles still re-render when their own event payload changes.
export default memo(MessageBubble);
