# Project Rules Files Design

## Goal

Give Codex and Claude the same concise, repository-local context without maintaining duplicate rule sets.

## Files

- `project-rules.md` is the canonical project context and engineering-policy document.
- `AGENTS.md` imports `project-rules.md` for Codex-compatible agents.
- `CLAUDE.md` imports `project-rules.md` for Claude-compatible agents.

## Canonical Rules Content

`project-rules.md` will describe the current planned product and its non-negotiable boundaries:

- Silpo-focused personalized web service and Telegram Mini App.
- Planned stack: React 19/Vite, NestJS/Node.js 24, PostgreSQL 18 with Prisma, Redis 8 only as cache, Docker Compose.
- MVP architecture: modular monolith; no microservices, Kafka, BullMQ, or runtime LLM dependency.
- Silpo OAuth/MCP credentials remain server-side, encrypted, and never appear in client responses or commits.
- Product Score, price tracking, and discount calculations remain deterministic and explainable.
- Unknown MCP schemas, rate limits, pricing behavior, and write capabilities must be verified before implementation assumptions are made.

## Import Format

Both consumer files contain only `@project-rules.md`. This keeps the project rules in one place and lets each agent load them through its native project-instruction mechanism.

## Verification

Check that all three files exist, the two imports exactly reference the canonical filename, and `git diff --check` succeeds. No automated test is needed for Markdown-only instruction files.
