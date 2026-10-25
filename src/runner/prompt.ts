import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../core/context.ts';
import { readProjectFile } from '../core/projects.ts';
import { listQuestions } from '../core/questions.ts';
import { listEvents } from '../core/events.ts';
import { findMilestone, listMilestones } from '../core/milestones.ts';
import { listTasks } from '../core/tasks.ts';
import type { Project } from '../core/types.ts';
import type { TaskRow } from '../core/tasks.ts';

/**
 * Agents run with full permissions (`--permission-mode bypassPermissions`): any shell command, git
 * included (merge, rebase, cherry-pick, reset...), package managers, tests, builds, network. Only the
 * deny rules below still apply: pushing is the server's job (push_policy) after the owner approves.
 */
export const DEFAULT_ALLOWED_TOOLS = ['mcp__brain', 'mcp__brain__*'];

/**
 * Built-in tools offered to the agent (`--tools`); project allowed_tools may add more by name. Left out on
 * purpose: tools that schedule, notify or spawn work outside the run (Cron*, ScheduleWakeup, RemoteTrigger,
 * Workflow, PushNotification, SendMessage, Monitor, EnterWorktree/ExitWorktree).
 */
export const BUILTIN_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'Skill',
  'ToolSearch',
  'AskUserQuestion',
];

export function builtinTools(projectAllowed: string[]): string[] {
  const extra = projectAllowed.map((t) => t.replace(/\(.*$/, '').trim()).filter((t) => t && !t.startsWith('mcp__'));
  return [...new Set([...BUILTIN_TOOLS, ...extra])];
}

export const DISALLOWED_TOOLS = ['Bash(git push *)', 'Bash(git push)'];

export function systemPrompt(ctx: Ctx, task: TaskRow, project: Project): string {
  const lines = [
    `You are an agent working one task from the owner's Second Brain task manager (task ${task.id}, project "${project.name}").`,
    'You have full permissions in this session: run any command you need (git, package managers, tests, builds, scripts, network). Nobody is watching the terminal, so never wait for interactive input.',
    '',
    'Rules:',
    '- When a decision belongs to the owner (requirements, preferences, approvals, anything ambiguous or risky), ask with the mcp__brain__ask_human tool instead of guessing. Make that call the only tool call in its message. The session pauses until the owner replies, and the answer comes back as the tool result. If the tool says the question was sent and tells you to stop, end your turn right away.',
    '- Do not ask the owner to run commands for you; you can run them yourself.',
    '- Before deciding conventions yourself, check the knowledge base with mcp__brain__search_knowledge. Save durable learnings with mcp__brain__save_knowledge. Use mcp__brain__get_task_context to re-read the task and the conversation so far.',
    '- Follow-up work outside this task goes into mcp__brain__create_task, not into this change.',
  ];
  if (task.branch) {
    const base = task.base_branch ?? 'its base branch';
    lines.push(
      `- You work in your own git worktree on branch \`${task.branch}\` (base: \`${base}\`). Commit your work on this branch with clear messages. You may merge \`${base}\` into it, rebase, cherry-pick or reset it when the task needs that. Do not push, do not switch this worktree to another branch, and do not modify other branches: on approval Second Brain squash-merges your branch into \`${base}\`, so leave every change committed.`,
    );
    if (project.setup_command) lines.push(`- The worktree is a fresh checkout without installed dependencies or ignored files. If they are missing, run the project setup first: \`${project.setup_command}\` (BRAIN_REPO points at the owner's main checkout, e.g. to copy .env files from it).`);
    else lines.push('- The worktree is a fresh checkout: install dependencies (and copy ignored files such as .env from $BRAIN_REPO, the owner\'s main checkout) if you need them to build or test.');
  } else {
    lines.push('- This project has no git repository; keep changes inside the working directory.');
  }
  if (project.verify_command && task.kind === 'work') {
    lines.push(`- Before you finish, run the project's checks and make them pass: \`${project.verify_command}\`. Second Brain runs the same command after you finish and sends failures back to you.`);
  }
  lines.push('- Finish with a short summary for the owner: what you did, how you verified it, what to check, anything left open.');
  const extra = readProjectFile(ctx, project.slug, 'CLAUDE.md');
  if (extra?.trim()) lines.push('', '## Project instructions', '', extra.trim());
  return lines.join('\n');
}

/** Earlier questions/answers and review notes, so a fresh session (e.g. a restart) has the thread. */
export function threadSoFar(ctx: Ctx, taskId: string): string {
  const parts: string[] = [];
  for (const q of listQuestions(ctx, { taskId }).reverse()) {
    if (!q.answer) continue;
    for (const a of q.answer) parts.push(`- Q: ${a.question}\n  A: ${a.answer}`);
  }
  for (const e of listEvents(ctx, taskId)) {
    if (e.type === 'task.changes_requested') parts.push(`- Review note from the owner: ${String(e.payload.note ?? '')}`);
  }
  return parts.join('\n');
}

export function initialPrompt(ctx: Ctx, task: TaskRow, project: Project, note?: string | null): string {
  if (task.kind === 'plan') return planPrompt(ctx, task, project, note);
  const sections = [`# Task: ${task.title}`, '', task.body.trim() || '_(no description)_'];
  if (note) sections.unshift('> ' + note, '');
  const milestone = task.milestone_id ? findMilestone(ctx, task.milestone_id) : undefined;
  if (milestone) sections.push('', `## Milestone: ${milestone.title}`, '', milestone.description.trim() || '_(no description)_');
  const projectMd = readProjectFile(ctx, project.slug, 'PROJECT.md');
  if (projectMd?.trim()) sections.push('', '## Project (PROJECT.md)', '', projectMd.trim());
  const indexFile = path.join(ctx.cfg.brainDir, 'knowledge', 'index.md');
  if (existsSync(indexFile)) sections.push('', '## Knowledge index (global)', '', readFileSync(indexFile, 'utf8').trim());
  const thread = threadSoFar(ctx, task.id);
  if (thread) sections.push('', '## Conversation with the owner so far', '', thread);
  return sections.join('\n');
}

/** Open work on the board, one line per task, for the planner. */
function boardSummary(ctx: Ctx, project: Project, skip: string): string {
  const milestones = new Map(listMilestones(ctx, project.slug).map((m) => [m.id, m.title]));
  const tasks = listTasks(ctx, { project: project.slug }).filter((t) => t.id !== skip);
  const open = tasks.filter((t) => t.status !== 'done');
  const recent = tasks.filter((t) => t.status === 'done').slice(0, 15);
  const line = (t: TaskRow) =>
    `- ${t.id} [${t.status}${t.kind === 'plan' ? ', planner' : ''}] ${t.title}${t.milestone_id ? ` (milestone: ${milestones.get(t.milestone_id) ?? t.milestone_id})` : ''}${t.depends_on.length ? ` (depends on ${t.depends_on.join(', ')})` : ''}`;
  return [
    '### Open tasks',
    open.length ? open.map(line).join('\n') : '_(none)_',
    '',
    '### Recently done',
    recent.length ? recent.map(line).join('\n') : '_(none)_',
  ].join('\n');
}

/** Prompt of a planner task: shape the project, then queue the next concrete tasks. */
export function planPrompt(ctx: Ctx, task: TaskRow, project: Project, note?: string | null): string {
  const milestones = listMilestones(ctx, project.slug);
  const sections = [
    `# Plan the next steps of project "${project.name}"`,
    '',
    'You are the planner for this project. Your job is not to change code but to keep the project moving: a clear goal, milestones, and a queue of small, concrete tasks that other agents can pick up one by one.',
    '',
    'Do this:',
    '1. Read PROJECT.md below. If the goal, scope, constraints or priorities are missing or too vague to plan from, ask the owner with mcp__brain__ask_human (a few focused questions at once, with suggested options). Do not invent goals.',
    project.repo_path ? '2. Look at the repository (code, README, docs, recent git log) to learn where the project actually stands.' : '2. Look at the project folder and knowledge base to learn where the project stands.',
    '3. Rewrite PROJECT.md with mcp__brain__update_project_doc: goal, users, scope and non-goals, constraints, current state, and how to run/test it. Keep it short and factual; keep what the owner wrote unless it is outdated.',
    '4. Make sure the milestones describe the next few deliverables in order (mcp__brain__create_milestone). Do not duplicate existing ones.',
    '5. Create the next 3-8 tasks with mcp__brain__create_task: each one small enough for one agent session (well under 30 minutes), with a clear description and acceptance criteria, the milestone it belongs to, and depends_on for tasks that need another task\'s work first (create them in dependency order, or fix the wiring afterwards with mcp__brain__update_task). Check the board below and do not duplicate open tasks.',
    '6. Do not edit the repository yourself.',
    '7. End with a short summary: what you changed in PROJECT.md, the milestones, the tasks you queued and why in that order, and the open questions for the owner.',
  ];
  if (note) sections.unshift('> ' + note, '');
  if (task.body.trim()) sections.push('', '## What the owner asked the planner to focus on', '', task.body.trim());
  const projectMd = readProjectFile(ctx, project.slug, 'PROJECT.md');
  sections.push('', '## PROJECT.md (current)', '', projectMd?.trim() || '_(empty)_');
  sections.push(
    '',
    '## Milestones',
    '',
    milestones.length
      ? milestones.map((m) => `- ${m.id} [${m.status}] ${m.title} — ${m.done}/${m.total} tasks done${m.due ? `, due ${m.due}` : ''}${m.description ? `\n  ${m.description.replace(/\n/g, ' ')}` : ''}`).join('\n')
      : '_(none yet)_',
  );
  sections.push('', '## Board', '', boardSummary(ctx, project, task.id));
  const indexFile = path.join(ctx.cfg.brainDir, 'knowledge', 'index.md');
  if (existsSync(indexFile)) sections.push('', '## Knowledge index (global)', '', readFileSync(indexFile, 'utf8').trim());
  const thread = threadSoFar(ctx, task.id);
  if (thread) sections.push('', '## Conversation with the owner so far', '', thread);
  return sections.join('\n');
}
