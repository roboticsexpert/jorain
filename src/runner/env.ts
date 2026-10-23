/**
 * Environment for a spawned `claude -p`.
 *
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed so the CLI uses the owner's subscription login.
 * - Variables a parent Claude Code session sets (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_AGENT_SDK_*, ...) are
 *   removed too: when the server is started from inside a Claude Code session they leak into the child
 *   and break its auth (e.g. CLAUDE_CODE_SIMPLE=1 is what --bare sets). ANTHROPIC_BASE_URL is dropped in
 *   that case as well, since it then points at the parent's proxy.
 */
const STRIP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'BAGGAGE'];
const STRIP_PREFIX = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_PREVIEW_'];

export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const insideClaude = Boolean(base.CLAUDECODE || base.CLAUDE_CODE_ENTRYPOINT);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP.includes(k) || STRIP_PREFIX.some((p) => k.startsWith(p))) continue;
    if (insideClaude && k === 'ANTHROPIC_BASE_URL') continue;
    env[k] = v;
  }
  // AskUserQuestion is how agents ask the owner; make sure headless mode offers it.
  env.CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL = '1';
  return { ...env, ...extra };
}
