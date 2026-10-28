# Second Brain – Project Docs

Read these first in a new session.

| File | What it holds |
|------|---------------|
| [01-vision.md](01-vision.md) | What the owner wants, in their own terms (requirements) |
| [02-architecture.md](02-architecture.md) | Architecture as built (and the original proposal) |
| [03-decisions.md](03-decisions.md) | Decision log + open questions still waiting on the owner |
| [04-implementation-plan.md](04-implementation-plan.md) | Approved plan for phases 1–2 (task manager, knowledge, agents) |
| [04-running.md](04-running.md) | How to start the server, add projects/tasks, answer questions, where logs live; web UI notes in `web/README.md` |
| [05-api-contract.md](05-api-contract.md) | HTTP API shared by the server and the web UI |
| [06-scaling-roadmap.md](06-scaling-roadmap.md) | Gaps for managing large projects, from real usage, and the proposed order of work |
| [07-task-thread.md](07-task-thread.md) | Task thread (built 2026-10-28): a per-task thread for non-blocking agent updates, owner action items, and owner messages into a running session |
| [08-task-composer.md](08-task-composer.md) | Proposal (not built): a per-project chat that drafts well-formed tasks for the owner to create |
| [09-project-groups.md](09-project-groups.md) | Proposal (not built): group projects (e.g. backend + frontend) into one product with a combined board, read access between siblings, and cross-project tasks |

Conventions
- Code, docs and commit messages are in English. The owner may write in Persian; replies are always English.
- Keep these docs current: when something is decided or learned, update the file instead of leaving it stale.
