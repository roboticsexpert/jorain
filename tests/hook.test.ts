import { describe, expect, it } from 'vitest';
import { decide } from '../src/hooks/pretooluse.ts';

const ask = { tool_name: 'mcp__brain__ask_human', tool_use_id: 'toolu_1', tool_input: { questions: [{ question: 'Colour?' }] } };

describe('PreToolUse hook decisions', () => {
  it('defers an unanswered question and allows it with the stored answers', () => {
    expect(decide(ask, () => null)?.permissionDecision).toBe('defer');
    const d = decide(ask, () => [{ question: 'Colour?', answer: 'blue' }]);
    expect(d).toMatchObject({ permissionDecision: 'allow', updatedInput: { questions: [{ question: 'Colour?' }], answers: [{ question: 'Colour?', answer: 'blue' }] } });
  });

  it('gives AskUserQuestion its { question: answer } map', () => {
    const d = decide({ ...ask, tool_name: 'AskUserQuestion' }, () => [{ question: 'Colour?', answer: 'blue' }]);
    expect(d?.updatedInput?.answers).toEqual({ 'Colour?': 'blue' });
  });

  it('denies git push in any position, and leaves other commands (merge and rebase included) alone', () => {
    for (const command of ['git push', 'git push origin main', 'cd repo && git push -f', 'git -C /x push', 'echo hi; git push'])
      expect(decide({ tool_name: 'Bash', tool_input: { command } }, () => null)?.permissionDecision, command).toBe('deny');
    for (const command of ['git commit -m "push the button"', 'git status', 'git log --oneline', 'echo git', 'git merge main', 'git rebase -i HEAD~2', 'git cherry-pick abc'])
      expect(decide({ tool_name: 'Bash', tool_input: { command } }, () => null), command).toBeNull();
    expect(decide({ tool_name: 'Read', tool_input: {} }, () => null)).toBeNull();
  });
});
