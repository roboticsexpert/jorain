import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { StreamParser, type StreamOutcome } from './stream.ts';

export interface ClaudeArgs {
  prompt?: string;
  sessionId: string;
  resume: boolean;
  mcpConfig: string;
  settings: string;
  settingSources: string;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string;
  maxTurns: number;
  model?: string | null;
}

/**
 * Flags for a headless run. Never --bare: it disables the subscription (OAuth) login. bypassPermissions
 * gives the agent every tool without prompts; --disallowedTools deny rules and the PreToolUse hook still apply.
 */
export function buildArgs(a: ClaudeArgs): string[] {
  const args = ['-p'];
  if (a.prompt !== undefined) args.push(a.prompt);
  args.push(a.resume ? '--resume' : '--session-id', a.sessionId);
  args.push(
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', a.mcpConfig,
    '--strict-mcp-config',
    '--settings', a.settings,
    '--setting-sources', a.settingSources,
    '--permission-mode', 'bypassPermissions',
    '--permission-prompts', 'none',
    '--max-turns', String(a.maxTurns),
    '--append-system-prompt', a.appendSystemPrompt,
  );
  if (a.model) args.push('--model', a.model);
  // Variadic flags last, each value as its own argv entry.
  args.push('--tools', a.tools.join(','));
  args.push('--allowedTools', ...a.allowedTools);
  args.push('--disallowedTools', ...a.disallowedTools);
  return args;
}

export interface ClaudeExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
  outcome: StreamOutcome;
  stderr: string;
}

export interface RunningClaude {
  child: ChildProcess;
  done: Promise<ClaudeExit>;
  kill(): void;
}

/** Spawns `claude`, appends every stdout line to logPath and reports each parsed line. */
export function spawnClaude(opts: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs: number;
  onLine?: (line: string, index: number) => void;
}): RunningClaude {
  const child = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(opts.logPath, { flags: 'a' });
  const parser = new StreamParser();
  let index = 0;
  let buf = '';
  let stderr = '';
  let timedOut = false;
  let killed = false;

  const handle = (line: string) => {
    if (!line.trim()) return;
    log.write(line + '\n');
    parser.push(line);
    opts.onLine?.(line, index++);
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (c: string) => {
    stderr = (stderr + c).slice(-20_000);
  });

  const stop = () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);

  const done = new Promise<ClaudeExit>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf) handle(buf);
      if (stderr.trim()) log.write(JSON.stringify({ type: 'brain_stderr', text: stderr.trim() }) + '\n');
      log.end(() => resolve({ exitCode, signal, timedOut, killed, outcome: parser.outcome(), stderr }));
    };
    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });

  return {
    child,
    done,
    kill() {
      killed = true;
      stop();
    },
  };
}
