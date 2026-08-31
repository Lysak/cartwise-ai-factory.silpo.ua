# IMPLEMENT prompt — Silpo MCP Identity Discovery

Copy this into a **new, clean IMPLEMENT session** from the repository root.

```text
You are in IMPLEMENT mode for Cartwise. Execute only the approved plan:

docs/superpowers/plans/2026-08-30-silpo-mcp-identity-discovery.md

Read, in this order:
1. AGENTS.md
2. project-rules.md
3. docs/idea.md sections 2–3
4. the approved plan above
5. this narrow handoff

Do not read or rely on the preceding PLAN-session history. Do not run rlx init, create plan.md, use a git worktree, commit, or broaden scope.

Goal: create a browser/Telegram-neutral, browser-bound OAuth discovery flow that calls only official Silpo OAuth and MCP tools/list. Persist only a sanitized MCP catalog. Do not create a User, SilpoConnection, local authenticated session, or persistent discovery credential. Do not call candidate profile/account tools: the next PLAN will choose one only after tools/list evidence.

Current verified runtime facts:
- public origin: https://silpo.lysak.pp.ua
- tunnel lifecycle: make tunnel-up, make tunnel-down, make tunnel-logs
- local database starts empty: User=0, SilpoConnection=0, OAuthState=0, OAuthClient=0
- Cloudflare tunnel reaches Vite; Vite allows silpo.lysak.pp.ua
- .env holds APP_ORIGIN and local secrets; inspect only presence, never print values
- the user, not you, completes the interactive Silpo login. Never request or handle password, OTP, authorization code, callback URL, cookies, or raw tokens.

Process:
1. Execute every checkbox in the approved plan task-by-task, with TDD and fresh command output.
2. Preserve unrelated dirty changes.
3. Before live OAuth, ask the user to click the site button and complete login themselves.
4. Read only the sanitized McpProbe evidence and report candidate identity tool names/schema, tool count, User count, and SilpoConnection count.
5. Stop at the identity decision gate. Do not invent a stable subject, call arbitrary MCP tools, or begin the Silpo-first migration.
6. Run the plan's final verification commands. Report pass/fail evidence and the known unrelated backend ESLint failure separately if it remains.

Final response must contain:
- completed/remaining plan checkboxes;
- sanitized MCP catalog evidence and candidate identity-tool names;
- proof that User=0 and SilpoConnection=0 after discovery;
- exact recommendation for the next PLAN; and
- no secrets or personal Silpo data.
```
