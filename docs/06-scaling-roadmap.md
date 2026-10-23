# Scaling to large projects – gap analysis and roadmap (2026-10-23)

Goal from the owner: manage several **large** projects in Second Brain, with Claude pushing them forward.

Evidence used: the live DB (`brain/state.sqlite`, 13 tasks in shop + website, 22 runs, 11 questions) and the project knowledge notes the agents wrote.

## What the real usage shows

| # | Symptom in the data | Root cause |
|---|---|---|
| E1 | t_asddkg spent 5 runs and 4 questions only asking the owner to move its branch (merge / cherry-pick / reset). t_skd4p6 is stuck the same way. Neither has written a line of the actual feature. | A task's branch is cut once and never updated. Agents may not merge/rebase/checkout, and the server offers no "update branch from base". F8 (dependencies) prevents new cases but not branches that already exist or bases that move on. |
| E2 | Knowledge note *"Agent sessions can't run shell commands"*: pnpm test/check/build and curl are denied. t_y88fxa and t_ji6yc4 could not verify their work; a second "verify and commit" task was created by hand. | `DEFAULT_ALLOWED_TOOLS` allows only git add/commit/status/diff/log. With `--permission-prompts none` every other Bash call is silently denied. Agents ship unverified code. |
| E3 | Duplicate tasks (two llms.txt tasks, a build task + a verify task). | Follow-on of E2, and no way to see "what is already planned" at a glance for a project. |
| E4 | Both `PROJECT.md` files are the empty template (Goal / Constraints blank). | Nothing asks for or maintains them, yet they are the only project context injected into every run. |
| E5 | All 13 tasks were written by the owner. | The vision says "Claude tries to move projects forward on its own", but nothing plans: no goals, milestones, or a planner that turns a goal into tasks. |
| E6 | One task runs per project at a time, in the owner's own checkout; a dirty tree pauses the whole project. | Runs use `repo_path` directly instead of an isolated git worktree. |

## Gaps for "large projects"

1. **Branch hygiene (E1)** – fixes stuck work today.
2. **Agents can verify (E2)** – per-project commands (test / build / lint) the agent may run, and the runner runs them before `review`.
3. **Structure above tasks (E4, E5)** – project goal, milestones/epics, task → milestone, progress per milestone.
4. **Planner (E5)** – an agent that reads PROJECT.md + milestones + board and proposes the next tasks (into `inbox` for owner triage), and keeps PROJECT.md current.
5. **Parallelism and isolation (E6)** – one git worktree per task, so N tasks per project can run and the owner's checkout is never touched or blocking.
6. **Reach the owner** – questions and reviews only appear in the web UI; a large portfolio needs push notifications (Telegram per the vision) and a daily digest.
7. **Budgets and visibility** – cost per project/milestone, per-project limits, a portfolio overview page.

## Proposed order

| Step | Item | Size |
|---|---|---|
| 1 | Server-side "sync branch with base" (reset when the branch has no own commits, else merge-tree merge; conflict → ask/Request changes) + run it automatically before each start/resume. Unblocks t_asddkg, t_skd4p6. | S |
| 2 | Per-project `commands` (e.g. `pnpm test`, `pnpm build`) added to allowed tools + a verify step before `review`. | S–M |
| 3 | Git worktree per task; concurrency per project configurable. | M |
| 4 | Milestones: table, task.milestone_id, board grouping/filter, progress. PROJECT.md editable in UI. | M |
| 5 | Planner run per project (manual button first, scheduled later), output lands in `inbox`. | M |
| 6 | Telegram notifications + answer/approve from Telegram. | M–L |
| 7 | Portfolio overview + cost per project. | S–M |

Status (2026-10-23): owner approved steps 1–5 and 7, plus "agents get full permissions" first; step 6 (Telegram) dropped. All built the same day; see D10–D15 in 03-decisions.md and the "Worktrees and sync", "Verification" and "Planner" sections of 05-api-contract.md.
