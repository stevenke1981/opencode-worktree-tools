import type { Database } from "bun:sqlite";
import { type Plugin, tool } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { loadWorktreeConfig } from "./config";
import { createWorktree, getWorktreePath, listWorktrees, quietCommit, removeWorktree } from "./git";
import {
  addSession,
  clearPendingDelete,
  getAllSessions,
  getPendingDelete,
  getSessionByPath,
  initStateDb,
  removeSession,
  setPendingDelete,
} from "./state";
import { copyFiles, runHooks, symlinkDirs } from "./sync";
import { buildOpenCodeLaunchArgv, openTerminal } from "./terminal";
import { validateBranchName } from "./validate";

const PLUGIN_MARKER = "opencode-worktree-tools";

const WORKTREE_TOOLS_GUIDANCE = `<WORKTREE_TOOLS_PLUGIN>
You have dedicated Git worktree tools. Prefer them over raw \`git worktree\` bash:

| Tool | Use when |
|------|----------|
| \`worktreeCreate\` | Create an isolated worktree + spawn OpenCode in a new terminal |
| \`worktreeDelete\` | Mark current worktree session for cleanup (commits + removes on session end) |
| \`worktreeList\` | List active plugin-managed worktree sessions and git worktrees |

Workflow:
1. \`worktreeCreate\` with a branch name (e.g. feature/dark-mode)
2. Work in the spawned isolated terminal session
3. \`worktreeDelete\` with a reason when done — cleanup runs on session.idle

Config: \`.opencode/worktree.jsonc\` (auto-created) controls sync, hooks, terminal mode (\`newTerminal\`), and session history (\`preserveHistory\`).
Storage: ~/.local/share/opencode/worktree/<project-id>/<branch>/
</WORKTREE_TOOLS_PLUGIN>`;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type Shell = Plugin extends (input: infer I) => unknown ? I["$"] : never;

let db: Database | null = null;
let projectRoot: string | null = null;
let cleanupRegistered = false;

function registerCleanupHandlers(database: Database): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.close();
    } catch {
      // best effort
    }
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("beforeExit", cleanup);
}

async function getDb(root: string): Promise<Database> {
  if (db) return db;
  if (!projectRoot) throw new Error("Database not initialized");
  db = await initStateDb(root);
  registerCleanupHandlers(db);
  return db;
}

async function isGitRepo($: Shell, directory: string): Promise<boolean> {
  try {
    return (await $`git -C ${directory} rev-parse --is-inside-work-tree`.text()).trim() === "true";
  } catch {
    return false;
  }
}

function makeLogger(client: Parameters<Plugin>[0]["client"]): Logger {
  return {
    info: (msg) => {
      client.app.log({ body: { service: PLUGIN_MARKER, level: "info", message: msg } }).catch(() => {});
    },
    warn: (msg) => {
      client.app.log({ body: { service: PLUGIN_MARKER, level: "warn", message: msg } }).catch(() => {});
    },
  };
}

export const WorktreeToolsPlugin: Plugin = async ({ client, directory, $ }) => {
  const inRepo = await isGitRepo($, directory);
  const log = makeLogger(client);

  projectRoot = directory;
  const database = inRepo ? await getDb(directory) : null;

  await client.app.log({
    body: {
      service: PLUGIN_MARKER,
      level: "info",
      message: inRepo
        ? "Worktree tools active"
        : "Worktree tools loaded (not in a git repo)",
    },
  });

  return {
    config: async (config) => {
      if (!inRepo) return;
      config.instructions = config.instructions ?? [];
      const hasMarker = config.instructions.some(
        (item) => typeof item === "string" && item.includes(PLUGIN_MARKER),
      );
      if (!hasMarker) {
        config.instructions.push(
          `${PLUGIN_MARKER}: prefer worktreeCreate/worktreeDelete/worktreeList over raw git worktree bash`,
        );
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!inRepo || !output.messages.length) return;

      const firstUser = output.messages.find((m) => m.info.role === "user");
      if (!firstUser?.parts.length) return;
      if (firstUser.parts.some((p) => p.type === "text" && p.text.includes("<WORKTREE_TOOLS_PLUGIN>"))) {
        return;
      }

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: WORKTREE_TOOLS_GUIDANCE });
    },

    "experimental.session.compacting": async (_input, output) => {
      if (!inRepo) return;
      output.context.push(`
## Worktree Tools (${PLUGIN_MARKER})
Prefer: worktreeCreate, worktreeDelete, worktreeList.
Never use raw \`git worktree add/remove\` when plugin tools are available.
Config: .opencode/worktree.jsonc (\`newTerminal\`, \`preserveHistory\`, sync, hooks)
`);
    },

    tool: {
      worktreeCreate: tool({
        description:
          "Create an isolated git worktree and spawn a new terminal with OpenCode (prefer over bash git worktree)",
        args: {
          branch: tool.schema.string().describe("Branch name, e.g. feature/dark-mode"),
          baseBranch: tool.schema
            .string()
            .optional()
            .describe("Base branch to create from (defaults to HEAD)"),
        },
        async execute(args, toolCtx) {
          if (!database) return "Not in a git repository.";

          const branchError = validateBranchName(args.branch);
          if (branchError) return `Invalid branch name: ${branchError}`;

          if (args.baseBranch) {
            const baseError = validateBranchName(args.baseBranch);
            if (baseError) return `Invalid base branch name: ${baseError}`;
          }

          const config = await loadWorktreeConfig(directory, (level, msg) => {
            if (level === "info") log.info(msg);
            else log.warn(msg);
          });

          const result = await createWorktree(
            directory,
            args.branch,
            args.baseBranch,
            config.worktreePath,
          );
          if (!result.ok) return `Failed to create worktree: ${result.error}`;

          const worktreePath = result.value;

          if (config.sync.copyFiles.length) {
            await copyFiles(directory, worktreePath, config.sync.copyFiles, (msg) => log.info(msg));
          }
          if (config.sync.symlinkDirs.length) {
            await symlinkDirs(directory, worktreePath, config.sync.symlinkDirs, (msg) => log.info(msg));
          }
          if (config.hooks.postCreate.length) {
            await runHooks(worktreePath, config.hooks.postCreate, (msg) => log.info(msg));
          }

          // Launch opencode directly in the worktree directory (no --session flag).
          // This lets opencode create a fresh natural session, avoiding subagent view.
          const launchArgv = buildOpenCodeLaunchArgv(worktreePath);
          const terminalResult = await openTerminal(worktreePath, launchArgv, args.branch, config.newTerminal);

          if (!terminalResult.success) {
            return [
              `Worktree created at ${worktreePath}`,
              `Terminal spawn failed: ${terminalResult.error ?? "unknown error"}`,
              "Run opencode manually in the worktree directory.",
            ].join("\n");
          }

          addSession(database, {
            id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, // placeholder ID
            branch: args.branch,
            path: worktreePath,
            createdAt: new Date().toISOString(),
          });

          const terminalDesc = terminalResult.method ?? (config.newTerminal ? "new terminal" : "terminal tab");

          return [
            `Worktree created at ${worktreePath}`,
            `Branch: ${args.branch}`,
            `Opened in ${terminalDesc}.`,
          ].join("\n");
        },
      }),

      worktreeDelete: tool({
        description:
          "Delete the current worktree session (commits changes and removes worktree on session end)",
        args: {
          reason: tool.schema.string().describe("Brief reason for deleting this worktree"),
        },
        async execute(_args, toolCtx) {
          if (!database) return "Not in a git repository.";

          // Find worktree by matching the current session's directory
          // (we no longer pre-create sessions, so lookup by path instead of ID)
          let worktreePath: string | null = null;
          try {
            const sessionInfo = await client.session.get({ path: { id: toolCtx.sessionID } });
            const dir = sessionInfo.data?.directory;
            if (dir) worktreePath = dir;
          } catch {
            // fall through
          }

          if (!worktreePath) {
            return "No worktree associated with this session. Only worktree sessions created via worktreeCreate can be deleted.";
          }

          const session = getSessionByPath(database, worktreePath);
          if (!session) {
            return "No worktree associated with this session. Only worktree sessions created via worktreeCreate can be deleted.";
          }

          setPendingDelete(database, { branch: session.branch, path: session.path });
          return [
            `Worktree "${session.branch}" marked for cleanup.`,
            `Path: ${session.path}`,
            "Changes will be committed and the worktree removed when this session ends.",
          ].join("\n");
        },
      }),

      worktreeList: tool({
        description: "List plugin-managed worktree sessions and git worktrees (prefer over bash git worktree list)",
        args: {
          includeGit: tool.schema
            .boolean()
            .optional()
            .default(true)
            .describe("Include output from git worktree list"),
        },
        async execute(args) {
          if (!database) return "Not in a git repository.";

          const sessions = getAllSessions(database);
          const lines: string[] = ["## Plugin-managed sessions"];

          if (!sessions.length) {
            lines.push("(none)");
          } else {
            for (const s of sessions) {
              lines.push(`- ${s.branch} → ${s.path} (session ${s.id}, created ${s.createdAt})`);
            }
          }

          if (args.includeGit) {
            lines.push("", "## Git worktrees");
            lines.push(await listWorktrees(directory));
          }

          const config = await loadWorktreeConfig(directory, () => {});
          const examplePath = await getWorktreePath(directory, "<branch>", config.worktreePath);
          lines.push("", `Default storage pattern: ${examplePath.replace("<branch>", "{branch}")}`);

          return lines.join("\n");
        },
      }),
    },

    event: async ({ event }: { event: Event }) => {
      if (!database || event.type !== "session.idle") return;

      const pending = getPendingDelete(database);
      if (!pending) return;

      const config = await loadWorktreeConfig(directory, (level, msg) => {
        if (level === "info") log.info(msg);
        else log.warn(msg);
      });

      if (config.hooks.preDelete.length) {
        await runHooks(pending.path, config.hooks.preDelete, (msg) => log.info(msg));
      }

      const commitMessage = `chore(worktree): session snapshot\n\nAutomated worktree cleanup by ${PLUGIN_MARKER}.`;
      const commitResult = await quietCommit($, pending.path, commitMessage);
      if (!commitResult.ok) log.warn(`Commit before delete failed: ${commitResult.error}`);

      const removeResult = await removeWorktree(directory, pending.path);
      if (!removeResult.ok) log.warn(`Worktree remove failed: ${removeResult.error}`);

      clearPendingDelete(database);
      removeSession(database, pending.branch);
      log.info(`Cleaned up worktree: ${pending.branch} (${pending.path})`);
    },
  };
};

export default WorktreeToolsPlugin;