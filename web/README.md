# Second Brain – web UI

Vite + React + TypeScript app for the Second Brain backend. Built strictly against
[`docs/05-api-contract.md`](../docs/05-api-contract.md); the types live in `src/api/types.ts`.

Pages: **Overview** (landing page, `GET /api/portfolio`: a totals strip plus one card per active
project with task counts, open questions, open-milestone progress bars, cost last 7 days / total, a
"planning…" badge and a "Plan next steps" button; clicking a project opens its board), **Board**
(columns per status, project + milestone filters, task drawer with live run log, questions,
commits/diff, checks output, milestone select, "Update from base", actions, and a "Conversation"
thread: Claude's updates and to-dos with Done/Decline + note, and a box to write to Claude), **Inbox** (open
questions, to-dos and unread updates from Claude, tasks in review), **Knowledge** (notes by scope, Markdown view/edit, search),
**Schedules** (one-off and repeating task templates: list with next/last run and a link to
the last task, on/off switch, Run now, edit/delete; a form with a repeat picker or custom cron and a
preview of the next 3 runs from `GET /api/schedules/preview`), **Projects** (create/edit/archive; settings incl. verify/setup commands, parallel tasks and
auto-plan, group; a planner button with optional focus; milestones list/add/edit/done/delete; a PROJECT.md
editor; MCP config view; **groups**: create/rename/delete, member projects, a GROUP.md editor). A status strip at the
bottom shows `GET /api/status`, updated from the `status` SSE event.

## Two modes

| Mode | How | What it talks to |
|---|---|---|
| Real | `pnpm --dir web dev` | Vite on `:5173` proxies `/api` (including the SSE stream `/api/events`) to the backend on `http://localhost:3141`. |
| Mock | `pnpm --dir web dev:mock` (sets `VITE_MOCK=1`) | No backend needed. `src/mock/` serves every contract endpoint from in-memory seed data and fakes the SSE stream: the seeded in-progress run streams `run.log` lines and lands in review, a fake scheduler starts `auto` todo tasks every 25 s, and starting/answering/requesting changes runs a fake session that either asks a question (`question.created`) or finishes in review. Milestones, PROJECT.md, schedules and the portfolio are served from the seed (the mock does not evaluate cron: a recurring schedule's next run is always an hour away); "Plan next steps" creates a planner task that asks a question; sync always answers `up_to_date`. State resets on reload. |

Set `VITE_API_TARGET` to proxy somewhere other than `:3141`. To test the whole loop without the Claude
subscription, run a private backend with the fake agent and point the UI at it:

```bash
BRAIN_DIR=/tmp/brain-e2e BRAIN_PORT=3151 BRAIN_CLAUDE_BIN=$PWD/tests/fake-claude.mjs pnpm dev   # repo root
VITE_API_TARGET=http://localhost:3151 pnpm --dir web dev
```

With the fake agent, a task title containing `ASK` asks a question, `MAXTURNS` fails, and anything else commits.

The mock code is loaded with a dynamic import behind `import.meta.env.VITE_MOCK`, so it is not part
of a normal production build.

## Scripts

```bash
pnpm --dir web install      # own package.json and lockfile, separate from the root package
pnpm --dir web dev          # real mode, proxy to :3141
pnpm --dir web dev:mock     # mock mode
pnpm --dir web build        # type check (tsc -b) + build to web/dist (served by the backend)
pnpm --dir web typecheck    # type check only
pnpm --dir web preview      # serve the built dist
```

## Layout

```
src/
  api/types.ts        contract types and labels
  api/client.ts       fetch wrapper (errors → ApiError), SSE subscription; switches to the mock in mock mode
  live.tsx            single SSE connection, status, inbox badge count, toasts
  mock/               fake backend (data.ts seed, server.ts router + simulated runs)
  components/         TaskDrawer, QuestionForm, RunLog, TaskForm, small UI pieces, useMilestones
  pages/              Overview, Board, Inbox, Knowledge, Projects
  lib/                frontmatter parsing, time formatting, stream-json line summaries
  styles.css          plain CSS, light/dark via prefers-color-scheme
```

## Look and feel

Deliberately playful ("cute") styling, all plain CSS in `src/styles.css` (light + dark tokens on `:root`):

- Violet→pink accent gradient (brand, primary buttons), pill-shaped buttons and nav, 12px radii.
- Every status has an emoji (`STATUS_EMOJI` in `src/components/ui.tsx`): 📥 inbox, 📝 todo, Clawd, Claude Code's pixel mascot (`Clawd`, inline SVG built from its terminal block art — not a keyboard emoji) for in progress,
  🙋 waiting for you, 👀 review, ✅ done, 🧱 blocked, 💥 failed. Columns also get their own colour (top border + count).
- A card in progress has an animated gradient border and a `WorkingChip` ("Clawd + Claude is working •••": Clawd hops and blinks; the status strip shows it hopping while runs are active);
  a waiting card shows "🙋 Needs your answer" (hand waves). Badges: 🔥 high / 💤 low, 💬 questions.
- Empty columns and `Empty` states show a friendly line + emoji; drawer slides in, modals pop in.
- All animation is switched off under `prefers-reduced-motion: reduce`.

## Behaviour notes (choices where the contract is silent)

- **Answers:** each sub-question's `answer` is the picked option labels plus any free text, joined
  with `", "` (multiSelect gives several labels). Every sub-question needs a non-empty answer.
- **Cancel** is offered for every status except `done` and `blocked`; it is a two-step button.
- **Manual moves** in the drawer only offer `inbox ↔ todo ↔ blocked` (the contract's allowed set);
  `review → done` is the Approve button ("Approve & merge" when the branch has commits: the
  server squash-merges it). Merged, unpushed tasks get a Push button (Retry push after a failure).
- **Depends on** in the drawer lists each dependency by title with its live status badge; each one
  links to `?task=<id>` (other query params kept), so you can jump to whatever is holding the task up.
- **Git badge** on cards and in the drawer header: `● N` commits on the branch, `merged`, `pushed`,
  or `push failed`. The project form has an "After approve" push policy select (repo projects only).
- **Board updates** come from `task.updated`; a task id the board has not seen yet is added (the
  backend sends `task.updated` for created tasks too). `project.updated` refreshes project lists.
- **Activity feed** renders the persisted event types from the contract as sentences; unknown
  types fall back to raw JSON. Empty question `header`/option `description` are hidden.
- **Routes:** Overview is `/`, the board is `/board` (`?project=`, `?milestone=<id>|none`, `?task=`).
  Old `/?task=…` / `/?project=…` links redirect to the board.
- **Overview** refetches the portfolio (debounced) on `task.updated`, `milestone.*`, `project.updated`,
  `run.ended` and question events rather than patching aggregates. Counts are work tasks only (the
  contract excludes planner tasks). A 409 from "Plan next steps" is shown as an info toast.
- **Checks:** `verify_status` shows as `✓ checks` / `✗ checks` next to the git badge; the drawer shows
  the output of the latest `task.verify` event (open by default when it failed).
- **Update from base** (`POST /tasks/:id/sync`) is offered for tasks with a branch that are not
  `in_progress` or `done`; the result (incl. conflicting files) is shown under the actions.
- **Project form:** verify/setup commands are shown for repo projects only; empty sends `null`.
  PROJECT.md reloads on `project.updated` unless it has unsaved edits.
- **Search snippets** show the `**…**` match markers from FTS5 as highlighted text.
- **Knowledge:** new notes are written with `PUT /api/knowledge/note` and a generated frontmatter
  (`title`, `tags`, `updated`); the editor edits the whole file, frontmatter included.
- **Groups** (see `docs/09-project-groups.md`): the Projects sidebar lists each group (🧩, click for its
  settings and GROUP.md) with its projects indented under it, then the ungrouped ones; `?group=<slug>` /
  `?newgroup=1` select a group / the new-group form. The board's project picker also offers groups
  (`/board?group=<slug>`, `GET /api/tasks?group=`): cards then carry a project chip, waiting-badge tooltips name the
  dependency's project and title, and "New task" offers only the group's projects (first member preselected).
  The overview shows each group's project cards under a header with summed open/review/cost ("Other
  projects" below). Knowledge lists `group:<slug>` scopes (path `groups/<slug>/knowledge/`) before the
  group's projects. The drawer shows the group next to the project and tags dependencies of another project
  with that project's name. `useGroups()` (`src/components/groups.ts`) keeps the group list current from
  `group.updated` / `group.deleted`. The mock seeds a "Shop" group (`shop-api` + `shop-web`) with a
  cross-project dependency.
- **Run log:** lines are shown as one-line summaries of the stream-json events (toggle "raw JSON").
  Lines are stored by index, so the initial `GET /log` and live `run.log` events never duplicate.
