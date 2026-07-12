# opencode-worktree-tools

Global OpenCode plugin for **isolated git worktrees** — rewritten from [opencode-worktree](https://github.com/kdcokenny/opencode-worktree) using the same patterns as `opencode-git-tools`.

## Features

- **worktreeCreate** — create a git worktree, sync config files, run hooks, fork session, spawn terminal with OpenCode
- **worktreeDelete** — mark session for cleanup (auto-commit + remove worktree on `session.idle`)
- **worktreeList** — list plugin sessions and `git worktree list`
- AI guidance hooks (instructions + message transform + compacting)
- Slash commands: `/worktree-create`, `/worktree-delete`, `/worktree-list`

## Improvements over upstream

| Area | Change |
|------|--------|
| Architecture | Follows `opencode-git-tools` plugin + install + commands layout |
| Dependencies | No OCX / jsonc-parser / zod — uses `tool.schema` and built-in JSONC stripper |
| Launch | Plain `opencode --session <id>` (no OCX profile required) |
| Commit | Quiet file-based commit on delete (no terminal noise) |
| Tools | Added `worktreeList`; camelCase tool names matching git tools |
| Windows | First-class Windows Terminal + cmd fallback |
| **Guidance hooks** | **AI discovers plugin tools via injected context (see below)** |

### Key Innovation: Guidance Hooks

Unlike the original [opencode-worktree](https://github.com/kdcokenny/opencode-worktree), which registers plugin tools silently, this fork uses **three guidance hooks** to make the AI aware of the tools.

**The problem:** Plugin tools registered via the `tool:` hook exist at runtime and execute correctly, but they don't appear in the LLM's static function definitions list — unlike MCP tools or `.opencode/tools/` custom tools. An AI agent has no way to discover them.

**The solution:** Three hooks inject tool descriptions into the AI's conversation context:

| Hook | What it does |
|------|-------------|
| `config.instructions` | Appends a note to every system prompt |
| `experimental.chat.messages.transform` | Injects a detailed tool table into the first user message |
| `experimental.session.compacting` | Re-injects guidance after long-context summarization |

For full details, see [`docs/dev/guidance-hook.md`](docs/dev/guidance-hook.md).

## For humans — quick start

### Install

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

```bash
./install.sh
```

Restart OpenCode after install.

### What gets installed

| Path | Purpose |
|------|---------|
| `~/.config/opencode/plugins/opencode-worktree-tools/index.ts` | Plugin entrypoint |
| `~/.config/opencode/plugins/opencode-worktree-tools/*.ts` | Helper modules |
| `~/.config/opencode/commands/worktree-*.md` | Slash commands |

OpenCode auto-loads files directly under `~/.config/opencode/plugins/`. This
plugin uses a subdirectory because it has helper modules; only `index.ts` should
be registered as the plugin entrypoint.

### Configuration

Auto-created at `.opencode/worktree.jsonc`:

```jsonc
{
  "worktreePath": "~/my-worktrees",  // optional
  "sync": {
    "copyFiles": [".env", ".env.local"],
    "symlinkDirs": ["node_modules"]
  },
  "hooks": {
    "postCreate": ["npm install"],
    "preDelete": ["docker compose down"]
  }
}
```

Worktrees are stored at `~/.local/share/opencode/worktree/<project-id>/<branch>/` by default.

### Verify

```bash
opencode run "call worktreeList and show the result"
```

In TUI: `/worktree-list`

## For AI agents — operating instructions

<!-- AGENT_README: opencode-worktree-tools v1.0 -->

You have **worktree\*** plugin tools for isolated git worktrees. Prefer them
over raw `git worktree` shell commands because they also track OpenCode session
state, config sync, terminal launch, and cleanup hooks.

### Decision: when to USE worktree*

| Task | Tool |
|------|------|
| Create isolated branch/session | `worktreeCreate` |
| Remove current worktree session safely | `worktreeDelete` |
| Inspect plugin-managed sessions | `worktreeList` |

### Decision: when NOT to use

| Situation | Use instead |
|-----------|-------------|
| Simple status/diff/commit | `git*` tools |
| User wants to edit current checkout only | Stay in current worktree |
| Destructive cleanup without confirmation | Ask first |
| Non-git project | Do not create worktrees |

### Standard workflow

```
worktreeList
  → worktreeCreate({ branch: "feature/name" })
  → work in spawned OpenCode session
  → worktreeDelete({ reason: "finished" })
```

### Rules

1. Use `worktreeCreate` instead of raw `git worktree add`
2. Use `worktreeDelete` instead of raw `git worktree remove`
3. Check `.opencode/worktree.jsonc` for copy/symlink hooks before creating
4. Keep helper modules under `plugins/opencode-worktree-tools/`; only `index.ts` is the plugin entrypoint

<!-- END_AGENT_README -->

## License

MIT
