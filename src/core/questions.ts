import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { badRequest, conflict, notFound, type Answer, type Question, type QuestionItem } from './types.ts';

const SELECT = `SELECT q.*, t.title AS task_title, t.project_slug AS project_slug FROM questions q JOIN tasks t ON t.id = q.task_id`;

const toQuestion = (r: any): Question => ({
  ...r,
  questions: JSON.parse(r.questions),
  answer: r.answer ? JSON.parse(r.answer) : null,
});

/** Normalises AskUserQuestion's `input.questions` into the stored shape. */
export function normaliseQuestions(input: unknown): QuestionItem[] {
  const list = (input as any)?.questions;
  // ask_human options may omit description/header; normalise to the AskUserQuestion shape.
  if (!Array.isArray(list) || !list.length) {
    // Not the expected shape: keep whatever text we have so the owner can still answer.
    return [{ question: typeof input === 'string' ? input : JSON.stringify(input), header: 'Question', multiSelect: false, options: [] }];
  }
  return list.map((q: any) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    multiSelect: Boolean(q.multiSelect),
    options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })) : [],
  }));
}

export function createQuestion(ctx: Ctx, taskId: string, toolUseId: string, input: unknown): Question {
  const existing = ctx.db.prepare('SELECT id FROM questions WHERE tool_use_id = ?').get(toolUseId) as { id: string } | undefined;
  if (existing) return getQuestion(ctx, existing.id);
  const id = newId('q');
  ctx.db
    .prepare('INSERT INTO questions (id, task_id, tool_use_id, questions, asked_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, taskId, toolUseId, JSON.stringify(normaliseQuestions(input)), now());
  recordEvent(ctx, taskId, 'question.created', { question_id: id });
  const q = getQuestion(ctx, id);
  publish('question.created', q);
  return q;
}

export function findQuestion(ctx: Ctx, id: string): Question | undefined {
  const r = ctx.db.prepare(`${SELECT} WHERE q.id = ?`).get(id);
  return r ? toQuestion(r) : undefined;
}

export function getQuestion(ctx: Ctx, id: string): Question {
  const q = findQuestion(ctx, id);
  if (!q) throw notFound(`question ${id}`);
  return q;
}

export function questionByToolUse(ctx: Ctx, toolUseId: string): Question | undefined {
  const r = ctx.db.prepare(`${SELECT} WHERE q.tool_use_id = ?`).get(toolUseId);
  return r ? toQuestion(r) : undefined;
}

export function listQuestions(ctx: Ctx, opts: { open?: boolean; taskId?: string } = {}): Question[] {
  const where: string[] = [];
  const vals: string[] = [];
  if (opts.open) where.push('q.answered_at IS NULL');
  if (opts.taskId) {
    where.push('q.task_id = ?');
    vals.push(opts.taskId);
  }
  return (ctx.db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY q.asked_at DESC, q.rowid DESC`).all(...vals) as any[]).map(
    toQuestion,
  );
}

export function openQuestionForTask(ctx: Ctx, taskId: string): Question | undefined {
  return listQuestions(ctx, { open: true, taskId })[0];
}

export function validateAnswers(answers: unknown): Answer[] {
  if (!Array.isArray(answers) || !answers.length) throw badRequest('answers must be a non-empty array');
  return answers.map((a: any) => {
    if (typeof a?.question !== 'string' || typeof a?.answer !== 'string' || !a.answer.trim()) throw badRequest('each answer needs question and answer strings');
    return { question: a.question, answer: a.answer };
  });
}

/** Stores the owner's answer. Does not resume the session; the runner does that. */
export function answerQuestion(ctx: Ctx, id: string, answers: Answer[]): Question {
  const q = getQuestion(ctx, id);
  if (q.answered_at) throw conflict(`question ${id} is already answered`);
  ctx.db.prepare('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify(validateAnswers(answers)), now(), id);
  recordEvent(ctx, q.task_id, 'question.answered', { question_id: id });
  const out = getQuestion(ctx, id);
  publish('question.answered', out);
  return out;
}

/** AskUserQuestion expects `answers` as a map from question text to the chosen label(s) / free text. */
export function answersForTool(answers: Answer[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of answers) map[a.question] = a.answer;
  return map;
}

/** Questions recorded by the ask_human tool itself (no hook pause); they resume with a prompt. */
export const isRecordedByTool = (q: Question) => q.tool_use_id.startsWith('mcp_');

/** One raw answer per sub-question: "2" picks that option, "1,3" several (multi-select), anything else is free text. */
export function resolveAnswers(q: Question, raw: string[]): Answer[] {
  if (raw.length !== q.questions.length) throw badRequest(`this question has ${q.questions.length} part(s); give one answer for each`);
  return q.questions.map((item, i) => {
    const parts = raw[i].split(',').map((s) => s.trim());
    const picked = parts.every((p) => /^\d+$/.test(p) && item.options[Number(p) - 1])
      ? parts.map((p) => item.options[Number(p) - 1].label).join(', ')
      : raw[i];
    return { question: item.question, answer: picked };
  });
}
