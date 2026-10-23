import type {
  Answer,
  McpConfig,
  Milestone,
  MilestonePatch,
  NewMilestone,
  NewProject,
  NewSchedule,
  NewTask,
  Note,
  NoteFile,
  Portfolio,
  Project,
  ProjectPatch,
  Question,
  Run,
  RunLog,
  Schedule,
  SchedulePatch,
  SearchHit,
  SseEvents,
  SseType,
  SyncResult,
  Status,
  Task,
  TaskDetail,
  TaskPatch,
  TaskStatus,
} from './types';
import { SSE_TYPES } from './types';

export const MOCK = import.meta.env.VITE_MOCK === '1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a transport returns: the HTTP status plus the raw body text. */
export interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

async function transport(method: string, path: string, body?: unknown): Promise<RawResponse> {
  if (MOCK) {
    const { mockFetch } = await import('../mock/server');
    return mockFetch(method, path, body);
  }
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let raw: RawResponse;
  try {
    raw = await transport(method, path, body);
  } catch (e) {
    throw new ApiError(0, 'network', `Cannot reach the backend (${(e as Error).message})`);
  }
  if (raw.status >= 400) {
    let code = 'http_' + raw.status;
    let message = raw.body || `HTTP ${raw.status}`;
    try {
      const parsed = JSON.parse(raw.body) as { error?: { code: string; message: string } };
      if (parsed.error) ({ code, message } = parsed.error);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(raw.status, code, message);
  }
  if (raw.status === 204 || raw.body === '') return undefined as T;
  if (raw.contentType.includes('application/json')) return JSON.parse(raw.body) as T;
  return raw.body as T;
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  status: () => request<Status>('GET', '/api/status'),

  projects: () => request<Project[]>('GET', '/api/projects'),
  project: (slug: string) => request<Project>('GET', `/api/projects/${encodeURIComponent(slug)}`),
  createProject: (p: NewProject) => request<Project>('POST', '/api/projects', p),
  updateProject: (slug: string, p: ProjectPatch) =>
    request<Project>('PATCH', `/api/projects/${encodeURIComponent(slug)}`, p),
  projectMcp: (slug: string) => request<McpConfig>('GET', `/api/projects/${encodeURIComponent(slug)}/mcp`),
  projectDoc: (slug: string) => request<{ content: string }>('GET', `/api/projects/${encodeURIComponent(slug)}/doc`),
  saveProjectDoc: (slug: string, content: string) =>
    request<{ content: string }>('PUT', `/api/projects/${encodeURIComponent(slug)}/doc`, { content }),
  planProject: (slug: string, focus?: string) =>
    request<Task>('POST', `/api/projects/${encodeURIComponent(slug)}/plan`, focus ? { focus } : {}),
  portfolio: () => request<Portfolio>('GET', '/api/portfolio'),

  milestones: (slug: string) => request<Milestone[]>('GET', `/api/projects/${encodeURIComponent(slug)}/milestones`),
  createMilestone: (slug: string, m: NewMilestone) =>
    request<Milestone>('POST', `/api/projects/${encodeURIComponent(slug)}/milestones`, m),
  updateMilestone: (id: string, p: MilestonePatch) => request<Milestone>('PATCH', `/api/milestones/${id}`, p),
  deleteMilestone: (id: string) => request<void>('DELETE', `/api/milestones/${id}`),

  schedules: (project?: string) => request<Schedule[]>('GET', `/api/schedules${q({ project })}`),
  createSchedule: (s: NewSchedule) => request<Schedule>('POST', '/api/schedules', s),
  updateSchedule: (id: string, p: SchedulePatch) => request<Schedule>('PATCH', `/api/schedules/${id}`, p),
  deleteSchedule: (id: string) => request<void>('DELETE', `/api/schedules/${id}`),
  runSchedule: (id: string) => request<Task>('POST', `/api/schedules/${id}/run`),
  cronPreview: (cron: string) => request<{ next: string[] }>('GET', `/api/schedules/preview${q({ cron })}`),

  tasks: (f: { project?: string; status?: TaskStatus[] } = {}) =>
    request<Task[]>('GET', `/api/tasks${q({ project: f.project, status: f.status?.join(',') })}`),
  task: (id: string) => request<TaskDetail>('GET', `/api/tasks/${id}`),
  createTask: (t: NewTask) => request<Task>('POST', '/api/tasks', t),
  updateTask: (id: string, p: TaskPatch) => request<Task>('PATCH', `/api/tasks/${id}`, p),
  startTask: (id: string) => request<Task>('POST', `/api/tasks/${id}/start`),
  approveTask: (id: string) => request<Task>('POST', `/api/tasks/${id}/approve`),
  pushTask: (id: string) => request<Task>('POST', `/api/tasks/${id}/push`),
  mergeTask: (id: string) => request<Task>('POST', `/api/tasks/${id}/merge`),
  requestChanges: (id: string, note: string) => request<Task>('POST', `/api/tasks/${id}/request-changes`, { note }),
  cancelTask: (id: string) => request<Task>('POST', `/api/tasks/${id}/cancel`),
  syncTask: (id: string) => request<{ result: SyncResult; task: Task }>('POST', `/api/tasks/${id}/sync`),
  taskDiff: (id: string) => request<string>('GET', `/api/tasks/${id}/diff`),

  openQuestions: () => request<Question[]>('GET', '/api/questions?open=true'),
  answerQuestion: (id: string, answers: Answer[]) =>
    request<Question>('POST', `/api/questions/${id}/answer`, { answers }),

  run: (id: string) => request<Run>('GET', `/api/runs/${id}`),
  runLog: (id: string, after = 0) => request<RunLog>('GET', `/api/runs/${id}/log?after=${after}`),

  notes: (scope?: string) => request<Note[]>('GET', `/api/knowledge${q({ scope })}`),
  note: (path: string) => request<NoteFile>('GET', `/api/knowledge/note${q({ path })}`),
  saveNote: (path: string, content: string) => request<Note>('PUT', '/api/knowledge/note', { path, content }),
  deleteNote: (path: string) => request<void>('DELETE', `/api/knowledge/note${q({ path })}`),
  search: (query: string, scope?: string) =>
    request<SearchHit[]>('GET', `/api/knowledge/search${q({ q: query, scope })}`),
};

export type SseHandler = <K extends SseType>(type: K, data: SseEvents[K]) => void;

/** Subscribe to /api/events (or the mock stream). Returns an unsubscribe function. */
export function subscribeEvents(handler: SseHandler, onConnection?: (ok: boolean) => void): () => void {
  if (MOCK) {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import('../mock/server').then(({ mockSubscribe }) => {
      if (cancelled) return;
      onConnection?.(true);
      stop = mockSubscribe(handler);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }
  const es = new EventSource('/api/events');
  es.onopen = () => onConnection?.(true);
  es.onerror = () => onConnection?.(false);
  for (const type of SSE_TYPES) {
    es.addEventListener(type, (ev) => {
      try {
        handler(type, JSON.parse((ev as MessageEvent<string>).data));
      } catch {
        /* ignore malformed event */
      }
    });
  }
  return () => es.close();
}
