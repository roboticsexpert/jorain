# Project groups: several repos that make one product (2026-10-28)

Status: **option B built on 2026-10-28** (owner: "build B"). Decisions D24–D26 in [03-decisions.md](03-decisions.md). The section **As built** is authoritative; the proposal below it is kept for context.

## As built

| Piece | Where |
|---|---|
| `project_groups(slug, name, …)`, `projects.group_slug` | migration `0008_groups.sql` (the table is not called `groups` because GROUPS is an SQL keyword) |
| Group CRUD, GROUP.md, `siblings()` / `siblingRepos()` | `src/core/groups.ts` |
| `group:<slug>` knowledge scope (`brain/groups/<slug>/knowledge/`) | `src/core/knowledge.ts` |
| Prompt: sibling rules in the system prompt, GROUP.md in work and planner prompts, sibling list for the planner | `src/runner/prompt.ts` |
| Sibling repos passed as `--add-dir` | `src/runner/claude.ts`, `orchestrator.ts` |
| Edit/Write/NotebookEdit denied inside a sibling repo (unless it contains the session's own cwd) | `src/hooks/pretooluse.ts`, hook matcher in `session-files.ts` |
| Agent tools: `create_task` and `project_board` accept a sibling `project`; `save_knowledge` / `search_knowledge` know scope `group` | `src/mcp/server.ts` |
| API: `/api/groups…`, `GET /api/tasks?group=`, `portfolio.groups`, SSE `group.updated` / `group.deleted` | `src/server/app.ts`, `live.ts`; [05-api-contract.md](05-api-contract.md) |
| CLI: `brain group add/set/rm/list`, `brain project set --group`, `brain task list -G` | `src/cli/index.ts` |
| Owner MCP: `groups`, `group_doc`, `project_settings.group`, `list_tasks.group`, group scope in notes | `src/mcp/owner.ts` |
| Web UI: group management + GROUP.md, group option on the board with project badges, grouped overview, group knowledge scope | `web/` |
| Tests | `tests/groups.test.ts` |

Answers used for the open points (the owner may revisit):
1. Tasks an agent files on a sibling go to the **inbox**.
2. A running task does **not** wait for a sibling task; it finishes and leaves a follow-up in its own project that depends on it.
3. **Read-only** access to siblings. Known gap: only file-edit tools are blocked in sibling repos; a Bash command could still write there (the prompt forbids it).

Not built yet: group-level milestones, group MCP servers.

---

# Proposal (2026-10-28)

## The need (owner's words, summarised)

Some projects belong together, e.g. a backend repo and a frontend repo that together are one product.
The owner wants to:

1. see the tasks of all of them side by side, and
2. let the agents working in one of them see the others and create tasks for each other
   (the frontend agent needs an endpoint → it files a task on the backend).

## Two ways to model it

| | A. One project, several repos | B. A group above projects (recommended) |
|---|---|---|
| Shape | `project` gets a `project_repos` list; each task picks one repo (or several) | New `groups` table; `projects.group_slug`; each project keeps its one repo |
| What changes | Almost everything that is per project today is really per repo: `repo_path`, `verify_command`, `setup_command`, `max_parallel`, `push_policy`, branch, worktree, base sha, sync, diff, delivery. All of it moves to a repo level and every task needs a repo field. | Nothing in the runner. Additions only: a group, a combined board, sibling access, cross-project task creation. |
| A task that touches both repos | Possible in one session, but needs two worktrees, two branches, two verifies and a merge that must succeed in both or neither. | Two tasks, one per repo, linked by a dependency (frontend task waits until the backend task is merged). `task_deps` already works across projects. |
| Risk | Large refactor of the most fragile code (worktrees, sync, delivery). | Small; existing projects keep working unchanged (a project without a group behaves as today). |

**Recommendation: B.** A task stays "one branch in one repo", which is what keeps delivery simple and
safe. "One product" is expressed by the group, not by merging the repos into one project.

## Proposal B in detail

### Data
- `groups(slug, name, created_at, updated_at)` and `projects.group_slug` (nullable).
- `brain/groups/<slug>/GROUP.md`: what the product is, how the parts talk (API contract, shared types,
  env/URLs), who owns what. Injected into every run of every project in the group, next to that project's
  `PROJECT.md`.
- `brain/groups/<slug>/knowledge/`: a third knowledge scope (global → group → project) that `search_knowledge`
  and `save_knowledge` understand. The API contract between backend and frontend lives here.
- Optional later: group MCP servers (`brain/groups/<slug>/mcp.json`) merged between global and project.

### Seeing the tasks together
- Board filter "Group: <name>" shows all tasks of the group's projects in the same columns, each card tagged
  with its project (colour/badge). Portfolio groups projects under their group with summed progress and cost.
- Cross-project dependencies are drawn on the cards ("waits for backend #t_abc").

### Agents can see the siblings
- Each run gets the sibling projects' repo paths with `--add-dir`, **read-only**: the PreToolUse hook denies
  Edit/Write/NotebookEdit and writing Bash outside the task's own worktree. The agent can read the backend's
  routes while working on the frontend, but every change goes through a task in the right repo.
- Siblings are read from the owner's main checkout (their base branch), not from other tasks' worktrees.
- The prompt lists the siblings: name, slug, what it is (from GROUP.md), path.
- `project_board` takes an optional `project` (sibling only) so an agent can check what is already planned
  before filing a duplicate.

### Agents create tasks for each other
- `create_task(project: <sibling>)` is already accepted today; the change is to allow it only within the group
  (plus the agent's own project) and to tell agents about it in the prompt.
- Typical flow: frontend task needs `POST /orders` → creates the backend task with acceptance criteria →
  makes its own follow-up (or itself, via a new "wait" option) depend on it. When the backend task is merged,
  the frontend task becomes runnable.
- Where the new task lands (inbox or todo) is an open point below.

### Optional later: a "feature" across the group
A group-level milestone (`milestones.group_slug`) so one feature ("checkout v2") collects the backend and
frontend tasks and shows one progress bar. Not needed for the first version.

## Open points for the owner
1. A task an agent creates on a sibling: **inbox** (owner approves it first, as today) or **todo** (starts on
   its own once its dependencies are met)?
2. Should a running task be able to wait for a sibling task it just created (park as "waiting on dependency"
   and resume when it is merged), or should it finish and leave a dependent follow-up task instead? The second
   is simpler and is the default in this proposal.
3. Is read-only access to siblings enough, or should a task ever edit two repos in one session (that would be
   model A, and is not recommended)?
