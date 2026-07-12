# Guidance Hooks — Making Plugin Tools Discoverable

## Problem: Plugin Tools Are Invisible to the LLM

Opencode has three mechanisms for adding custom tools, and they behave very differently:

| Mechanism | How tools are defined | Visible in LLM tool list? | Has access to... |
|-----------|----------------------|---------------------------|------------------|
| **MCP servers** | `mcp:` in `opencode.json` | ✅ **Yes** — injected as function definitions | External server process, network access |
| **Custom tools** (`.opencode/tools/*.ts`) | File-based, filename = tool name | ✅ **Yes** — injected as function definitions | `context.directory`, `context.worktree`, `context.sessionID` only |
| **Plugin `tool:` hook** | `return { tool: { name: tool({...}) } }` | ❌ **No** — exists at runtime but NOT in visible tool list | Full SDK: `client` object, `$` Bun shell, session fork/delete, event hooks |

Plugin tools registered via the `tool:` hook **execute correctly when called** — the opencode runtime resolves them. But the LLM **never sees them listed** alongside `bash`, `read`, `write`, etc. This is an opencode V1 limitation. The AI cannot discover them on its own.

## Why We Can't Use MCP Tools or Custom Tools Instead

It would be simpler to just use MCP tools or `.opencode/tools/` custom tools, which are visible. But they lack critical capabilities this plugin needs:

### What we need that only a plugin can provide

| Capability | Required for | Available in plugin? | Available in MCP/tools? |
|------------|-------------|---------------------|------------------------|
| **Session forking/creation** | Spawn new OpenCode session in worktree | ✅ `client.session.fork()` / `client.session.create()` | ❌ No SDK access |
| **Event hooks** (`session.idle`) | Auto-cleanup worktrees on session end | ✅ `event: async ({ event }) => {...}` | ❌ No event system |
| **Config injection** (`config.instructions`) | Tell AI about tools | ✅ `config: async (config) => {...}` | ❌ No config access |
| **Message transform** | Inject guidance into conversation | ✅ `experimental.chat.messages.transform` | ❌ No message access |
| **Compaction hooks** | Re-inject guidance after summarization | ✅ `experimental.session.compacting` | ❌ No compaction hooks |
| **SQLite state DB** | Track sessions across restarts | ✅ `bun:sqlite` | ❌ No persistent state |
| **Terminal spawning** | Open new terminal with OpenCode | ✅ Bun process spawning | ❌ Limited to tool return value |

**Bottom line:** The plugin's `tool:` hook is the **only** mechanism that gives us access to the SDK, event system, config hooks, and persistent state. MCP tools and custom tools are simpler but cannot fork sessions, listen for `session.idle`, or inject guidance into the conversation. We solve the visibility problem with guidance hooks instead.

## Solution: Three Guidance Hooks

The plugin injects tool descriptions into the AI's conversation context via three hooks, so the LLM learns about the tools *in words* even though the runtime won't show them *in definitions*.

### 1. `config` hook — system prompt note

```typescript
config: async (config) => {
  config.instructions = config.instructions ?? []
  const hasMarker = config.instructions.some(
    (item) => typeof item === "string" && item.includes(PLUGIN_MARKER),
  )
  if (!hasMarker) {
    config.instructions.push(
      `${PLUGIN_MARKER}: prefer worktreeCreate/worktreeDelete/worktreeList over raw git worktree bash`,
    )
  }
}
```

**What it does:** Appends a string to `config.instructions`, which opencode injects into every LLM system prompt. The AI sees this note at the top of every conversation.

**Why it matters:** The system prompt is always present in the LLM's context window, so the tool guidance survives across turns and conversations.

### 2. `experimental.chat.messages.transform` — first user message injection

```typescript
"experimental.chat.messages.transform": async (_input, output) => {
  if (!inRepo || !output.messages.length) return

  const firstUser = output.messages.find((m) => m.info.role === "user")
  if (!firstUser?.parts.length) return
  if (firstUser.parts.some((p) => p.type === "text" && p.text.includes("<WORKTREE_TOOLS_PLUGIN>"))) {
    return  // already injected — skip
  }

  const ref = firstUser.parts[0]
  firstUser.parts.unshift({ ...ref, type: "text", text: WORKTREE_TOOLS_GUIDANCE })
}
```

**What it does:** Injects a detailed XML block into the very first user message of every session. The guidance includes a tool table, workflow instructions, and configuration location.

**The guidance block:**

```xml
<WORKTREE_TOOLS_PLUGIN>
You have dedicated Git worktree tools. Prefer them over raw `git worktree` bash:

| Tool | Use when |
|------|----------|
| `worktreeCreate` | Create an isolated worktree + spawn OpenCode in a new terminal |
| `worktreeDelete` | Mark current worktree session for cleanup (commits + removes on session end) |
| `worktreeList` | List active plugin-managed worktree sessions and git worktrees |

Workflow:
1. `worktreeCreate` with a branch name
2. Work in the spawned isolated terminal session
3. `worktreeDelete` with a reason when done — cleanup runs on session.idle

Config: `.opencode/worktree.jsonc` (auto-created) controls file sync and hooks.
Storage: ~/.local/share/opencode/worktree/<project-id>/<branch>/
</WORKTREE_TOOLS_PLUGIN>
```

**Why it matters:** The first user message is always in context. By injecting guidance there, the AI sees the tool descriptions before it processes the user's actual request.

**Idempotency guard:** The `if (firstUser.parts.some(...includes("<WORKTREE_TOOLS_PLUGIN>")))` check prevents duplicate injection on repeated transform calls.

### 3. `experimental.session.compacting` — re-injection on summarization

```typescript
"experimental.session.compacting": async (_input, output) => {
  if (!inRepo) return
  output.context.push(`
## Worktree Tools (${PLUGIN_MARKER})
Prefer: worktreeCreate, worktreeDelete, worktreeList.
Never use raw \`git worktree add/remove\` when plugin tools are available.
Config: .opencode/worktree.jsonc
`)
}
```

**What it does:** When a long conversation gets summarized (compacted), this re-injects the tool guidance so the AI doesn't forget about the tools after compaction truncates the earlier context.

**Why it matters:** Without this, the injected guidance in the first user message would eventually get summarized away, and the AI would lose awareness of the tools in long sessions.

## Verification

Check the opencode log to confirm the guidance hooks are working:

```bash
grep "opencode-worktree-tools" ~/.local/share/opencode/log/latest.log
# Should show: "Worktree tools active"
```

After restart, the AI should reference the worktree tools without being prompted — evidence that the guidance hooks injected the tool descriptions into context.
