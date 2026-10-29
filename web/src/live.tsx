// App-wide live state: one SSE connection, status strip data, the inbox badge count and toasts.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, subscribeEvents, type SseHandler } from './api/client';
import type { Status, Task } from './api/types';
import { errorMessage } from './lib/util';

interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

interface LiveCtx {
  status: Status | null;
  statusError: string | null;
  connected: boolean;
  inboxCount: number;
  refreshInbox: () => void;
  subscribe: (h: SseHandler) => () => void;
  /** Bumped each time the SSE stream reconnects; events sent while disconnected are not replayed. */
  reconnects: number;
  toast: (text: string, kind?: Toast['kind']) => void;
  toastError: (e: unknown) => void;
}

const Ctx = createContext<LiveCtx | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reconnects, setReconnects] = useState(0);
  const everOpened = useRef(false);
  const handlers = useRef(new Set<SseHandler>());
  const inboxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Merged tasks whose push had no outcome yet: approve answers before the push ends, so its result is toasted here.
  const pushPending = useRef(new Set<string>());

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const toastError = useCallback((e: unknown) => toast(errorMessage(e), 'error'), [toast]);

  const loadInbox = useCallback(async () => {
    try {
      const [qs, review, msgs] = await Promise.all([api.openQuestions(), api.tasks({ status: ['review'] }), api.inboxMessages()]);
      setInboxCount(qs.length + review.length + msgs.length);
    } catch {
      /* status strip already shows backend errors */
    }
  }, []);
  const refreshInbox = useCallback(() => {
    clearTimeout(inboxTimer.current);
    inboxTimer.current = setTimeout(loadInbox, 250);
  }, [loadInbox]);

  useEffect(() => {
    api
      .status()
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((e) => setStatusError(errorMessage(e)));
    void loadInbox();
    return subscribeEvents(
      (type, data) => {
        if (type === 'status') setStatus(data as Status);
        if (type === 'task.updated') {
          const t = data as Task;
          if (t.merged_sha && !t.pushed_at && !t.push_error) pushPending.current.add(t.id);
          else if (pushPending.current.delete(t.id)) {
            if (t.pushed_at) toast(`Pushed ${t.merged_into}`);
            else if (t.push_error) toast(`Push of ${t.merged_into} failed: ${t.push_error}`, 'error');
          }
        }
        if (type === 'task.updated' || type === 'question.created' || type === 'question.answered' || type === 'task.message') refreshInbox();
        for (const h of handlers.current) h(type, data);
      },
      (ok) => {
        setConnected(ok);
        if (!ok) return;
        // The server does not replay missed events: refetch after a reconnect (status is re-sent on connect).
        if (everOpened.current) {
          void loadInbox();
          setReconnects((n) => n + 1);
        }
        everOpened.current = true;
      },
    );
  }, [loadInbox, refreshInbox, toast]);

  const subscribe = useCallback((h: SseHandler) => {
    handlers.current.add(h);
    return () => {
      handlers.current.delete(h);
    };
  }, []);

  return (
    <Ctx.Provider value={{ status, statusError, connected, inboxCount, refreshInbox, subscribe, reconnects, toast, toastError }}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useLive(): LiveCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLive outside LiveProvider');
  return c;
}

/** Run `handler` for every SSE event while the component is mounted. The latest handler is always used. */
export function useSse(handler: SseHandler) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(((type, data) => ref.current(type, data)) as SseHandler), [subscribe]);
}

/** Run `refetch` after the SSE stream reconnects, to catch up on events missed while disconnected. */
export function useReconnect(refetch: () => unknown) {
  const { reconnects } = useLive();
  const ref = useRef(refetch);
  ref.current = refetch;
  useEffect(() => {
    if (reconnects > 0) void ref.current();
  }, [reconnects]);
}
