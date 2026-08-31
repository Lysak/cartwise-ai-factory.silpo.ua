# Project Rules

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
- For production architecture, security, session, infrastructure, framework, and dependency choices, independently research current primary sources and recommend the current industry-standard default. Ask the user only when a product, legal, cost, or risk trade-off genuinely requires their decision; record the chosen rule in the relevant specification.
