import React, { useState } from 'react';
import { useToast } from '../toastContext.js';

export default function AskPage() {
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [citations, setCitations] = useState([]);
  const [openCitation, setOpenCitation] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setAnswer(null);
    setCitations([]);
    setOpenCitation(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q })
      });
      if (!res.ok) {
        let msg = 'Request failed';
        try { msg = (await res.json()).message || msg; } catch {}
        toast(msg, 'error');
        setLoading(false);
        return;
      }
      const data = await res.json();
      setAnswer(data.answer || '');
      setCitations(data.citations || []);
    } catch {
      toast('Network error', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h1>Ask</h1>
      <form className="card" onSubmit={submit}>
        <textarea
          placeholder="Ask a question about your documents…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={loading}
        />
        <div style={{ marginTop: '0.75rem' }}>
          <button type="submit" disabled={loading || !question.trim()}>
            {loading ? <><span className="spinner" />Thinking…</> : 'Submit'}
          </button>
        </div>
      </form>

      {loading && (
        <div className="card empty"><span className="spinner dark" />Thinking…</div>
      )}

      {answer !== null && !loading && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Answer</h3>
          <div className="answer">{answer}</div>
          {citations.length > 0 && (
            <>
              <div className="citations">
                {citations.map((c, i) => (
                  <span
                    key={i}
                    className="citation-chip"
                    onClick={() => setOpenCitation(openCitation === i ? null : i)}
                  >
                    [{i + 1}] {c.filename || `source ${i + 1}`}
                  </span>
                ))}
              </div>
              {openCitation !== null && citations[openCitation] && (
                <div className="citation-detail">
                  <div className="fname">{citations[openCitation].filename || `Source ${openCitation + 1}`}</div>
                  <div className="snippet">{citations[openCitation].snippet || citations[openCitation].text || ''}</div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}