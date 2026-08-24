import { useState } from 'react';

// All prompts taken verbatim from docs/EXAMPLES.md
const CATEGORIES = [
  {
    id: 'voting',
    emoji: '🗳️',
    label: 'Voting',
    prompts: [
      {
        title: 'Simple voting',
        lines: [
          'I want to build a voting app where my team can vote on lunch options.',
          'Show a list of restaurants, let people vote, and display the results in real-time.',
        ],
      },
      {
        title: 'Survey with multiple questions',
        lines: [
          'Create a feedback form with 5 questions about our team event.',
          'Questions should be rating (1-5) and one text comment.',
          'Show me a summary of all responses.',
        ],
      },
      {
        title: 'Decision maker',
        lines: [
          'Build an app where people can suggest ideas and vote on them.',
          'Anyone can add a new idea, and everyone can upvote or downvote.',
          'Sort by most votes.',
        ],
      },
    ],
  },
  {
    id: 'forms',
    emoji: '📝',
    label: 'Forms',
    prompts: [
      {
        title: 'Contact form',
        lines: [
          'I need a simple contact form with name, email, and message.',
          'Save the submissions and let me see them in a table.',
        ],
      },
      {
        title: 'Registration form',
        lines: [
          'Create an event registration form. Collect name, email, department, and dietary restrictions.',
          'Show me all registrations in a list I can export.',
        ],
      },
      {
        title: 'Request tracker',
        lines: [
          'Build a form where people can submit IT support requests.',
          'Track status (new, in progress, done) and let me update the status.',
        ],
      },
    ],
  },
  {
    id: 'ai',
    emoji: '🤖',
    label: 'AI-Powered',
    prompts: [
      {
        title: 'Q&A chatbot',
        lines: [
          'I want an AI chatbot that answers questions about our company policies.',
          'Simple chat interface, user types question, AI responds.',
        ],
      },
      {
        title: 'Document summarizer',
        lines: [
          'Build an app where I can paste long text and AI summarizes it.',
          'Show the original and summary side by side.',
        ],
      },
      {
        title: 'Idea generator',
        lines: [
          'Create an app where I describe a problem and AI suggests 5 possible solutions.',
          'Let me save the ones I like.',
        ],
      },
    ],
  },
  {
    id: 'dashboard',
    emoji: '📊',
    label: 'Dashboard',
    prompts: [
      {
        title: 'Status board',
        lines: [
          'Build a dashboard that shows project status.',
          'Each project has a name, owner, and status (red/yellow/green).',
          'Let me add and update projects.',
        ],
      },
      {
        title: 'Leaderboard',
        lines: [
          'Create a leaderboard for our hackathon.',
          'Show team name, project name, and score.',
          'Sort by highest score.',
        ],
      },
      {
        title: 'Announcement board',
        lines: [
          'Build a simple announcement board.',
          'I can post announcements with title and content.',
          'Show newest first.',
        ],
      },
    ],
  },
  {
    id: 'data',
    emoji: '📁',
    label: 'Data',
    prompts: [
      {
        title: 'Inventory tracker',
        lines: [
          'I need to track office supplies inventory.',
          'Add items with name, quantity, and location.',
          'Show a table of everything and let me update quantities.',
        ],
      },
      {
        title: 'Directory',
        lines: [
          'Create a team directory.',
          'Each person has name, role, email, and photo URL.',
          'Search by name or role.',
        ],
      },
      {
        title: 'Event calendar',
        lines: [
          'Build a simple event list.',
          'Add events with title, date, and description.',
          'Show upcoming events sorted by date.',
        ],
      },
    ],
  },
  {
    id: 'workflow',
    emoji: '🔄',
    label: 'Workflow',
    prompts: [
      {
        title: 'Approval workflow',
        lines: [
          'Build a request approval system.',
          'Someone submits a request, then I can approve or reject it.',
          'Show pending requests to me, show status to the requester.',
        ],
      },
      {
        title: 'Task list',
        lines: [
          'Create a shared task list for my team.',
          'Add tasks, assign to people, mark as done.',
          'Filter by person or status.',
        ],
      },
      {
        title: 'Sign-up sheet',
        lines: [
          'Build a sign-up sheet for time slots.',
          'Show available slots, let people claim one.',
          'Show who signed up for what.',
        ],
      },
    ],
  },
  {
    id: 'tips',
    emoji: '🎯',
    label: 'Tips',
    prompts: null,
  },
];

const STARTER_TEMPLATE = `I want to build a [type of app] for [who will use it].

The main features are:
1. [Feature 1]
2. [Feature 2]
3. [Feature 3]

It should store/show: [what data]`;

const STARTER_EXAMPLE = `I want to build a feedback collection app for my team.

The main features are:
1. A form to submit feedback
2. A page to view all feedback
3. Export feedback to CSV

It should store: name, rating (1-5), comments, date submitted`;

export default function ExamplesModal({ open, onClose, onUsePrompt }) {
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id);
  const [activePromptIdx, setActivePromptIdx] = useState(0);
  const [copiedTemplate, setCopiedTemplate] = useState(false);
  const [copiedExample, setCopiedExample] = useState(false);

  if (!open) return null;

  const category = CATEGORIES.find(c => c.id === activeCategory);
  const activePrompt = category.prompts ? category.prompts[activePromptIdx] : null;

  function switchCategory(id) {
    setActiveCategory(id);
    setActivePromptIdx(0);
  }

  function handleUse(lines) {
    onUsePrompt(lines.join('\n'));
    onClose();
  }

  function copyText(text, setter) {
    navigator.clipboard.writeText(text).then(() => {
      setter(true);
      setTimeout(() => setter(false), 2000);
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Example prompts">
      <div className="examples-modal examples-modal-wide" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="examples-modal-header">
          <div>
            <h3>💡 Example Prompts</h3>
            <p>Pick one to use as a starting point — you can edit it before sending.</p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Category tabs ── */}
        <div className="examples-modal-categories">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              className={`examples-cat-btn ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => switchCategory(cat.id)}
            >
              <span>{cat.emoji}</span> {cat.label}
            </button>
          ))}
        </div>

        {/* ── Two-panel body ── */}
        <div className="examples-modal-body">

          {/* ── LEFT: named prompt list (only for non-tips categories) ── */}
          {category.prompts && (
            <div className="examples-prompt-list">
              {category.prompts.map((prompt, i) => (
                <button
                  key={i}
                  className={`examples-prompt-list-item ${activePromptIdx === i ? 'active' : ''}`}
                  onClick={() => setActivePromptIdx(i)}
                >
                  <span className="examples-prompt-list-num">{i + 1}</span>
                  <span className="examples-prompt-list-title">{prompt.title}</span>
                </button>
              ))}
            </div>
          )}

          {/* ── RIGHT: detail panel ── */}
          <div className="examples-detail-panel">

            {/* Prompt categories (non-tips) */}
            {activePrompt && (
              <div className="examples-detail-content">
                <div className="examples-detail-title">
                  {category.emoji} {activePrompt.title}
                </div>

                {/* Full quoted prompt — every line visible */}
                <blockquote className="examples-detail-quote">
                  {activePrompt.lines.map((line, j) => (
                    <span key={j}>
                      {line}
                      {j < activePrompt.lines.length - 1 && <br />}
                    </span>
                  ))}
                </blockquote>

                <div className="examples-detail-actions">
                  <button
                    className="examples-use-btn examples-use-btn-large"
                    onClick={() => handleUse(activePrompt.lines)}
                  >
                    ✦ Use this prompt
                  </button>
                  <button
                    className="examples-copy-btn"
                    onClick={() => copyText(activePrompt.lines.join('\n'), () => {})}
                  >
                    Copy text
                  </button>
                </div>

                {/* Hint: navigate between prompts */}
                {category.prompts.length > 1 && (
                  <div className="examples-detail-nav">
                    <button
                      className="examples-nav-btn"
                      disabled={activePromptIdx === 0}
                      onClick={() => setActivePromptIdx(i => i - 1)}
                    >
                      ← Prev
                    </button>
                    <span className="examples-nav-count">
                      {activePromptIdx + 1} / {category.prompts.length}
                    </span>
                    <button
                      className="examples-nav-btn"
                      disabled={activePromptIdx === category.prompts.length - 1}
                      onClick={() => setActivePromptIdx(i => i + 1)}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Tips tab ── */}
            {activeCategory === 'tips' && (
              <div className="examples-tips">
                <div className="examples-tips-section">
                  <h4>✅ Good Prompts Include:</h4>
                  <ol className="examples-tips-list">
                    <li><strong>What it does</strong> — The main purpose</li>
                    <li><strong>Who uses it</strong> — Team, public, just you</li>
                    <li><strong>Key features</strong> — List 2–3 main things it should do</li>
                    <li><strong>Data involved</strong> — What information is stored/displayed</li>
                  </ol>
                </div>

                <div className="examples-tips-section">
                  <h4>❌ Avoid:</h4>
                  <ul className="examples-tips-list avoid">
                    <li>Being too vague: <em>"Make something cool"</em></li>
                    <li>Too many features at once: <em>"Build a full CRM with AI and integrations"</em></li>
                    <li>Technical jargon (unless you're a developer): <em>"Use Redis for caching"</em></li>
                  </ul>
                </div>

                <div className="examples-tips-section">
                  <h4>💡 Start Simple!</h4>
                  <div className="examples-tips-steps">
                    <div className="examples-tips-step"><span className="step-label">First:</span> "Build a voting form"</div>
                    <div className="examples-tips-step"><span className="step-label">Then:</span> "Add a results chart"</div>
                    <div className="examples-tips-step"><span className="step-label">Then:</span> "Let people add their own options"</div>
                  </div>
                </div>

                <div className="examples-tips-section">
                  <h4>🚀 Copy-Paste Starter — just fill in the blanks:</h4>
                  <div className="examples-starter-block">
                    <pre className="examples-starter-pre">{STARTER_TEMPLATE}</pre>
                    <button
                      className={`examples-copy-btn ${copiedTemplate ? 'copied' : ''}`}
                      onClick={() => copyText(STARTER_TEMPLATE, setCopiedTemplate)}
                    >
                      {copiedTemplate ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>

                  <p className="examples-starter-label">Example:</p>
                  <div className="examples-starter-block">
                    <pre className="examples-starter-pre">{STARTER_EXAMPLE}</pre>
                    <button
                      className={`examples-copy-btn ${copiedExample ? 'copied' : ''}`}
                      onClick={() => copyText(STARTER_EXAMPLE, setCopiedExample)}
                    >
                      {copiedExample ? '✓ Copied' : 'Copy'}
                    </button>
                    <button
                      className="examples-use-btn"
                      style={{ marginTop: '0.5rem' }}
                      onClick={() => handleUse([STARTER_EXAMPLE])}
                    >
                      Use this prompt →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="examples-modal-footer">
          <strong>💡 Tip:</strong> Start with the core feature, get it working, then ask for more.
        </div>
      </div>
    </div>
  );
}
