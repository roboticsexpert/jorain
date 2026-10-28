// Shapes shared with the web UI; keep in sync with docs/05-api-contract.md.

export type TaskStatus = 'inbox' | 'todo' | 'in_progress' | 'waiting_for_human' | 'review' | 'done' | 'blocked' | 'failed';
export type Priority = 1 | 2 | 3;
export type PushPolicy = 'never' | 'after_merge';
export type TaskKind = 'work' | 'plan';
export type VerifyStatus = 'passed' | 'failed';
export type ScheduleKind = 'once' | 'recurring';

export const PUSH_POLICIES: PushPolicy[] = ['never', 'after_merge'];
export const TASK_STATUSES: TaskStatus[] = ['inbox', 'todo', 'in_progress', 'waiting_for_human', 'review', 'done', 'blocked', 'failed'];

export interface Project {
  slug: string;
  name: string;
  repo_path: string | null;
  model: string | null;
  allowed_tools: string[];
  push_policy: PushPolicy;
  /** Shell command run in the task's worktree before review (e.g. `pnpm -s test`); null = no check. */
  verify_command: string | null;
  /** Shell command that prepares a fresh worktree (e.g. `pnpm install`); the agent runs it. */
  setup_command: string | null;
  /** Tasks of this project that may run at the same time, each in its own worktree. */
  max_parallel: number;
  /** Start a planner task by itself when the project runs out of open work. */
  auto_plan: boolean;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_slug: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: Priority;
  branch: string | null;
  session_id: string | null;
  result_summary: string | null;
  question_count: number;
  commit_count: number;
  merged_sha: string | null;
  merged_into: string | null;
  merged_at: string | null;
  pushed_at: string | null;
  push_error: string | null;
  depends_on: string[];
  waiting_on: string[];
  milestone_id: string | null;
  kind: TaskKind;
  worktree: string | null;
  verify_status: VerifyStatus | null;
  /** The schedule that queued this task, if any. */
  schedule_id: string | null;
  /** Set while the agent waits for the owner (wait_for_owner): for an action, or for any message. */
  waiting_for: WaitFor | null;
  /** Agent to-dos for the owner that are still open, and agent updates the owner has not read. */
  open_actions: number;
  unread_updates: number;
  created_at: string;
  updated_at: string;
}

export interface Milestone {
  id: string;
  project_slug: string;
  title: string;
  description: string;
  status: 'open' | 'done';
  position: number;
  due: string | null;
  /** Task counts by status (planner tasks excluded). */
  counts: Partial<Record<TaskStatus, number>>;
  total: number;
  done: number;
  created_at: string;
  updated_at: string;
}

/** A task template queued once at `run_at`, or whenever `cron` matches (server local time). */
export interface Schedule {
  id: string;
  project_slug: string;
  title: string;
  body: string;
  priority: Priority;
  kind: ScheduleKind;
  run_at: string | null;
  cron: string | null;
  enabled: boolean;
  /** When the scheduler queues the next task; null when disabled or a one-off that already ran. */
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

export interface Answer {
  question: string;
  answer: string;
}

export interface Question {
  id: string;
  task_id: string;
  task_title: string;
  project_slug: string;
  tool_use_id: string;
  questions: QuestionItem[];
  answer: Answer[] | null;
  asked_at: string;
  answered_at: string | null;
}

export interface WaitFor {
  tool_use_id: string;
  /** The action the agent waits for; null = any new message from the owner. */
  action_id: string | null;
  since: string;
}

export type MessageKind = 'update' | 'action' | 'message';
export type ActionStatus = 'open' | 'done' | 'declined';

/** One entry of a task's thread (docs/07-task-thread.md). */
export interface TaskMessage {
  id: string;
  task_id: string;
  task_title: string;
  project_slug: string;
  author: 'agent' | 'owner';
  /** update: material for the owner · action: something the owner has to do · message: plain chat. */
  kind: MessageKind;
  title: string;
  body: string;
  /** Actions only. */
  status: ActionStatus | null;
  /** The owner's note when resolving an action. */
  note: string | null;
  created_at: string;
  read_at: string | null;
  /** When the agent got this row's latest owner input; null while it is pending (or never needed). */
  delivered_at: string | null;
  resolved_at: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  session_id: string;
  kind: 'start' | 'resume';
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  stop_reason: string | null;
  usage: Record<string, unknown> | null;
  cost_usd: number | null;
  log_path: string;
}

export interface BrainEvent {
  id: number;
  task_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface Note {
  path: string;
  scope: 'global' | `project:${string}`;
  title: string;
  tags: string[];
  updated: string | null;
}

/** Error with an HTTP status and a stable code; the API maps it to `{ error: { code, message } }`. */
export class BrainError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) => new BrainError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new BrainError(400, 'bad_request', message);
export const conflict = (message: string) => new BrainError(409, 'conflict', message);
