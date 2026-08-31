# Project Rules

> **Document version:** 2026-09-13 18:01 EEST

## Product

Cartwise is a personalized web service and Telegram Mini App built on the official Silpo MCP. It helps users assess product quality, track product prices by store, and find the best valid discount scenario for a cart.

`docs/idea.md` is the source of truth for the product concept and planned architecture. The repository currently contains an architectural start, not an implemented application.

## Planned Stack

- Frontend: React 19, Vite, TypeScript, mobile-first UI, Telegram Mini App support.
- Backend: NestJS, TypeScript, Node.js 24 LTS; modular monolith.
- Data: PostgreSQL 18 with Prisma; Redis 8 only for cache and per-user MCP rate-limit counters.
- Local environment: Docker Compose.

## MVP Boundaries

- Implement only the official Silpo MCP provider for the hackathon.
- Keep Product Score, price tracking, barcode resolution, notifications, and discount calculations deterministic and explainable; runtime LLM is not core logic.
- Do not add microservices, Kafka, BullMQ, or a Redis job queue. Use PostgreSQL scheduling with `FOR UPDATE SKIP LOCKED` when scheduling is implemented.
- Do not assume MCP schemas, barcode lookup, price behavior, rate limits, OAuth refresh behavior, or write tools: verify them with the real MCP first.

## Security and Data

- Silpo OAuth access and refresh tokens stay server-side, encrypted with AES-256-GCM, and never appear in frontend responses, logs, or commits.
- Store only the minimum local user data required for the product; do not copy Silpo personal data without a concrete need.
- MCP actions that mutate user data require explicit user confirmation.

## Engineering

- Use the Super Powers and Ponytail skills for development work: follow the applicable Super Powers workflow and keep the implementation minimal with Ponytail.
- For normal or high-risk changes, use the installed `ralphex-lite` skill: create the task artifacts with `rlx init <task-slug> <repository>`, approve the plan and handoff before a fresh implementation context, then use a read-only independent review and verify every finding before fixing it. Do not use this workflow for trivial mechanical changes.
- Prefer the smallest change that implements the current MVP requirement; do not build speculative abstractions.
- Preserve unrelated changes. Do not run `git commit` unless the user explicitly says `виконай коміт`.
- Respond to the user in Ukrainian. Avoid unnecessary English loanwords; retain technical names only when they are needed for precision.
- For browser and Silpo OAuth checks, always use the canonical public origin `https://silpo.lysak.pp.ua/`, never the local Docker URL. `APP_ORIGIN` and the OAuth callback must use this same origin.
- For production architecture, security, session, infrastructure, framework, and dependency choices, independently research current primary sources and recommend the current industry-standard default. Ask the user only when a product, legal, cost, or risk trade-off genuinely requires their decision; record the chosen rule in the relevant specification.

## Documentation governance

- A conclusion from a conversation is a proposal, not an approved product or architecture decision. Before
  changing a canonical document for a new logical decision, name the target file(s), summarize the exact
  change, and obtain the user's explicit approval. Approval may cover a named, bounded group of changes;
  it does not authorize adjacent scope expansion.
- Record an approved decision in exactly one canonical home: product intent in `docs/idea.md`; architecture,
  contracts, and evidence in `docs/superpowers/specs/`; sequencing and executable work in
  `docs/superpowers/plans/`; unresolved product choices in the linked questions file; agent workflow rules
  here. Link to that home from other documents instead of duplicating the decision.
- From this rule onward, every newly created or logically modified canonical Markdown document must start
  with `> **Document version:** YYYY-MM-DD HH:MM EEST` and have a `## Change log` entry with the same
  minute timestamp and a concise, approved-change summary. Add the first version stamp when an older
  document is next modified; do not backfill invented history.
- A version stamp and changelog entry document an already approved change; they never replace approval.
  Typographic-only edits may be made only when explicitly requested and must not alter a decision.

## Change log

- **2026-09-13 18:01 EEST** — Set the canonical public origin for browser and Silpo OAuth checks.
- **2026-09-07 08:55 EEST** — Added Ukrainian-first communication and plain-language rule.
- **2026-09-06 11:18 EEST** — Added explicit approval, canonical-home, and minute-versioning rules for
  planning and architecture documentation.
