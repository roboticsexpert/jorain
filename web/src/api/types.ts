// Mirrors docs/05-api-contract.md. Change the contract first, then this file.

export type TaskStatus =
  | 'inbox'
  | 'todo'
  | 'in_progress'
  | 'waiting_for_human'
  | 'review'
  | 'done'
  | 'blocked'
  | 'failed';
export type Priority = 1 | 2 | 3;
export type PushPolicy = 'never' | 'after_merge';
export type TaskKind = 'work' | 'plan';
export type VerifyStatus = 'passed' | 'failed';
export type ScheduleKind = 'once' | 'recurring';

export interface Project {
  slug: string;
  name: string;
  repo_path: string | null;
  model: string | null;
  allowed_tools: string[];
  push_policy: PushPolicy;
  verify_command: string | null;
  setup_command: string | null;
  max_parallel: number;
  auto_plan: boolean;
  status: 'active' | 'archived';
  /** The group (product) this project belongs to, if any. */
  group_slug: string | null;
  created_at: string;
  updated_at: string;
}

/** Several projects (e.g. a backend and a frontend repo) that make one product. */
export interface Group {
  slug: string;
  name: string;
  /** Member project slugs. */
  projects: string[];
  created_at: string;
  updated_at: string;
}

export interface NewGroup {
  slug: string;
  name: string;
  projects?: string[];
}

/** `projects` replaces the member list exactly. */
export type GroupPatch = Partial<Pick<Group, 'name' | 'projects'>>;

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
  schedule_id: string | null;
  /** Set while the agent waits for the owner (wait_for_owner): for one action, or for any message. */
  waiting_for: WaitFor | null;
  /** Agent to-dos for the owner still open, and agent updates not read yet. */
  open_actions: number;
  unread_updates: number;
  created_at: string;
  updated_at: string;
}

export interface WaitFor {
  tool_use_id: string;
  action_id: string | null;
  since: string;
}

export type MessageKind = 'update' | 'action' | 'message';
export type ActionStatus = 'open' | 'done' | 'declined';

/** One entry of a task's thread: an agent update or to-do, or an owner message. */
export interface TaskMessage {
  id: string;
  task_id: string;
  task_title: string;
  project_slug: string;
  author: 'agent' | 'owner';
  kind: MessageKind;
  title: string;
  body: string;
  status: ActionStatus | null;
  note: string | null;
  created_at: string;
  read_at: string | null;
  delivered_at: string | null;
  resolved_at: string | null;
}

export interface Milestone {
  id: string;
  project_slug: string;
  title: string;
  description: string;
  status: 'open' | 'done';
  position: number;
  due: string | null;
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
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface NewSchedule {
  project_slug: string;
  title: string;
  body?: string;
  priority?: Priority;
  kind: ScheduleKind;
  run_at?: string | null;
  cron?: string | null;
  enabled?: boolean;
}

export type SchedulePatch = Partial<Omit<NewSchedule, 'project_slug'>>;

export interface ProjectSummary {
  project: Project;
  counts: Partial<Record<TaskStatus, number>>;
  open_questions: number;
  in_review: number;
  milestones: Milestone[];
  cost_usd: { total: number; last_7_days: number };
  runs: { total: number; last_7_days: number };
  last_activity: string | null;
  planning: boolean;
}

export interface Portfolio {
  projects: ProjectSummary[];
  groups: Group[];
  totals: { cost_usd: number; cost_last_7_days: number; open_questions: number; in_review: number; running: number };
}

export type SyncResult =
  | { status: 'up_to_date' | 'fast_forwarded' | 'merged' | 'no_branch'; base?: string }
  | { status: 'conflict'; base: string; conflicts: string[] };

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

export type NoteScope = 'global' | `group:${string}` | `project:${string}`;

export interface Note {
  path: string;
  scope: NoteScope;
  title: string;
  tags: string[];
  updated: string | null;
}

export interface NoteFile {
  path: string;
  scope: NoteScope;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface SearchHit {
  path: string;
  title: string;
  scope: NoteScope;
  snippet: string;
}

export interface Status {
  running: number;
  concurrency: number;
  claude_version: string | null;
  fts5: boolean;
}

export interface TaskDetail {
  task: Task;
  questions: Question[];
  runs: Run[];
  commits: Commit[];
  events: BrainEvent[];
  messages: TaskMessage[];
}

export interface McpConfig {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  merged: Record<string, unknown>;
}

export interface RunLog {
  lines: string[];
  next: number;
}

export interface NewProject {
  slug: string;
  name: string;
  repo_path?: string | null;
  model?: string | null;
  allowed_tools?: string[];
  push_policy?: PushPolicy;
  verify_command?: string | null;
  setup_command?: string | null;
  max_parallel?: number;
  auto_plan?: boolean;
  group_slug?: string | null;
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'repo_path'
    | 'model'
    | 'allowed_tools'
    | 'push_policy'
    | 'verify_command'
    | 'setup_command'
    | 'max_parallel'
    | 'auto_plan'
    | 'status'
    | 'group_slug'
  >
>;

export interface NewMilestone {
  title: string;
  description?: string;
  due?: string | null;
  position?: number;
}

export type MilestonePatch = Partial<Pick<Milestone, 'title' | 'description' | 'due' | 'position' | 'status'>>;

export interface NewTask {
  project_slug: string;
  title: string;
  body?: string;
  priority?: Priority;
  status?: 'inbox' | 'todo';
  depends_on?: string[];
  /** Milestone id or title of that project. */
  milestone?: string;
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'body' | 'priority' | 'status' | 'depends_on'>> & {
  /** Milestone id or title; null removes the task from its milestone. */
  milestone?: string | null;
};

// SSE event map: type -> data
export interface SseEvents {
  'task.updated': Task;
  'question.created': Question;
  'question.answered': Question;
  'task.message': TaskMessage;
  'run.started': Run;
  'run.log': { run_id: string; index: number; line: string };
  'run.ended': Run;
  'knowledge.changed': { path: string };
  'project.updated': Project;
  'group.updated': Group;
  'group.deleted': { slug: string };
  'milestone.updated': Milestone;
  'milestone.deleted': { id: string; project_slug: string };
  'schedule.updated': Schedule;
  'schedule.deleted': { id: string; project_slug: string };
  status: Status;
}
export type SseType = keyof SseEvents;
export const SSE_TYPES: SseType[] = [
  'task.updated',
  'question.created',
  'question.answered',
  'task.message',
  'run.started',
  'run.log',
  'run.ended',
  'knowledge.changed',
  'project.updated',
  'group.updated',
  'group.deleted',
  'milestone.updated',
  'milestone.deleted',
  'schedule.updated',
  'schedule.deleted',
  'status',
];

export const BOARD_STATUSES: TaskStatus[] = [
  'inbox',
  'todo',
  'in_progress',
  'waiting_for_human',
  'review',
  'done',
];
export const SIDE_STATUSES: TaskStatus[] = ['blocked', 'failed'];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  todo: 'Todo',
  in_progress: 'In progress',
  waiting_for_human: 'Waiting for you',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
};

export const PRIORITY_LABEL: Record<Priority, string> = { 1: 'Low', 2: 'Normal', 3: 'High' };
