# Project Rules Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one canonical project-rules document and make both agent instruction files import it.

**Architecture:** `project-rules.md` holds the repository context and non-negotiable constraints. `AGENTS.md` and `CLAUDE.md` contain only an import directive, preventing divergent copies.

**Tech Stack:** Markdown; no runtime dependencies.

## Global Constraints

- Keep the rules grounded in `docs/idea.md`; do not claim unimplemented code exists.
- Do not place credentials, tokens, or secrets in the repository.
- Use `@project-rules.md` exactly in both import files.
- Do not create a git commit unless the user explicitly says `виконай коміт`.

---

### Task 1: Add shared project context and imports

**Files:**
- Create: `project-rules.md`
- Create: `AGENTS.md`
- Create: `CLAUDE.md`

**Interfaces:**
- Consumes: the architectural intent in `docs/idea.md`.
- Produces: `@project-rules.md` imports understood by the two agent instruction files.

- [ ] **Step 1: Verify the files are absent**

Run: `test ! -e project-rules.md && test ! -e AGENTS.md && test ! -e CLAUDE.md`

Expected: exit code 0.

- [ ] **Step 2: Create the minimal canonical rules and import files**

`project-rules.md` states the product purpose, proposed stack, MVP boundaries, MCP verification requirements, and token-security rules. `AGENTS.md` and `CLAUDE.md` each contain exactly:

```markdown
@project-rules.md
```

- [ ] **Step 3: Verify the imports and Markdown diff**

Run: `test "$(cat AGENTS.md)" = '@project-rules.md' && test "$(cat CLAUDE.md)" = '@project-rules.md' && git diff --check`

Expected: exit code 0.
