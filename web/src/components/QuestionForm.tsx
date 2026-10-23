import { useState } from 'react';
import { api } from '../api/client';
import type { Answer, Question } from '../api/types';
import { useLive } from '../live';

interface Draft {
  picked: string[];
  other: string;
}

/** Joins picked labels and free text into the single `answer` string the contract expects. */
function toAnswer(d: Draft): string {
  return [...d.picked, d.other.trim()].filter(Boolean).join(', ');
}

/**
 * Renders one AskUserQuestion call: each sub-question with its header, options as choice buttons
 * (multiSelect respected) and a free-text field. Submits the contract's `answers` array.
 */
export function QuestionForm({ question, onAnswered }: { question: Question; onAnswered?: (q: Question) => void }) {
  const { toastError, toast } = useLive();
  const [drafts, setDrafts] = useState<Draft[]>(() => question.questions.map(() => ({ picked: [], other: '' })));
  const [busy, setBusy] = useState(false);

  const update = (i: number, d: Partial<Draft>) => setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, ...d } : x)));

  const toggle = (i: number, label: string) => {
    const q = question.questions[i];
    const cur = drafts[i].picked;
    if (q.multiSelect) update(i, { picked: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] });
    else update(i, { picked: cur[0] === label ? [] : [label] });
  };

  const complete = drafts.every((d) => toAnswer(d) !== '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!complete) return;
    const answers: Answer[] = question.questions.map((q, i) => ({ question: q.question, answer: toAnswer(drafts[i]) }));
    setBusy(true);
    try {
      const res = await api.answerQuestion(question.id, answers);
      toast('Answer sent — the session resumes.');
      onAnswered?.(res);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="qform" onSubmit={submit}>
      {question.questions.map((q, i) => (
        <fieldset key={i} className="qitem">
          <legend>
            {q.header && <span className="qheader">{q.header}</span>}
            {q.multiSelect && <span className="hint">pick any</span>}
          </legend>
          <p className="qtext">{q.question}</p>
          <div className="choices" role={q.multiSelect ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const on = drafts[i].picked.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  className={on ? 'choice on' : 'choice'}
                  aria-pressed={on}
                  onClick={() => toggle(i, o.label)}
                >
                  <span className="choice-label">
                    {q.multiSelect ? (on ? '☑ ' : '☐ ') : on ? '● ' : '○ '}
                    {o.label}
                  </span>
                  {o.description && <span className="choice-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder={q.options.length ? 'Or write your own answer…' : 'Your answer…'}
            value={drafts[i].other}
            onChange={(e) => update(i, { other: e.target.value })}
            aria-label={`Free-text answer for ${q.header || q.question}`}
          />
        </fieldset>
      ))}
      <div className="row end">
        <button type="submit" className="btn-primary" disabled={!complete || busy}>
          {busy ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </form>
  );
}

export function AnsweredQuestion({ question }: { question: Question }) {
  return (
    <div className="qanswered">
      {question.questions.map((q, i) => (
        <div key={i}>
          <div className="qtext">
            {q.header && <span className="qheader">{q.header}</span>} {q.question}
          </div>
          <div className="qa">→ {question.answer?.find((a) => a.question === q.question)?.answer ?? question.answer?.[i]?.answer ?? '—'}</div>
        </div>
      ))}
    </div>
  );
}
