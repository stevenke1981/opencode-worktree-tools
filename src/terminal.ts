import { chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildBashArgv, buildBatchArgv, escapeBash, escapeBatch } from "./shell";

export interface TerminalResult {
  success: boolean;
  error?: string;
  /** Human-readable description of what was opened (e.g. "new window", "tab in GNOME Terminal") */
  method?: string;
}

/** Detect if running inside an SSH session — disables GUI tab spawning. */
function isInsideSSH(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

/** Detect if running inside tmux. */
function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/** Map of /proc/PID/comm patterns to terminal names. */
const TERMINAL_COMM_MAP: Record<string, string> = {
  "gnome-terminal-": "gnome-terminal",
  "gnome-terminal": "gnome-terminal",
  kitty: "kitty",
  konsole: "konsole",
  "xfce4-terminal": "xfce4-terminal",
  terminator: "terminator",
  kgx: "kgx",
};

/** Check if a comm value matches any known terminal. */
function matchTerminal(comm: string): string | null {
  for (const [pattern, name] of Object.entries(TERMINAL_COMM_MAP)) {
    if (comm.startsWith(pattern) || comm === name) return name;
  }
  return null;
}

/**
 * Detect the parent terminal emulator on Linux by walking up /proc/PID/comm.
 * Returns a known terminal name or null.
 * Walks up to 5 levels to handle: terminal → shell → opencode → bun
 */
async function detectParentTerminal(): Promise<string | null> {
  if (process.platform !== "linux") return null;

  let pid = process.ppid;
  for (let depth = 0; depth < 5; depth++) {
    try {
      const comm = await readFile(`/proc/${pid}/comm`, "utf8");
      const name = comm.trim();
      const matched = matchTerminal(name);
      if (matched) return matched;

      // Read the parent PID of this process
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
      if (!ppidMatch) return null;
      const nextPid = parseInt(ppidMatch[1], 10);
      if (nextPid <= 0 || nextPid === pid) return null;
      pid = nextPid;
    } catch {
      return null;
    }
  }
  return null;
}

function wrapBashSelfCleanup(script: string): string {
  // Preserve the full PATH from the parent process — spawned shells (gnome-terminal --tab,
  // tmux split-window, etc.) may not inherit it due to non-interactive login-shell profiles.
  const pathExport = `export PATH="${escapeBash(process.env.PATH || "/usr/bin:/bin")}"`;
  return `#!/bin/bash
trap 'rm -f "$0"' EXIT INT TERM
${pathExport}
${script}`;
}

function wrapBatchSelfCleanup(script: string): string {
  return `@echo off
${script}
(goto) 2>nul & del "%~f0"`;
}

async function writeTempScript(content: string, ext: ".sh" | ".bat"): Promise<string> {
  const scriptPath = path.join(
    tmpdir(),
    `oc-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  await Bun.write(scriptPath, content);
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

export async function openTmuxWindow(options: {
  windowName: string;
  cwd: string;
  argv?: string[];
  newTerminal?: boolean;
}): Promise<TerminalResult> {
  const { windowName, cwd, argv = [], newTerminal = true } = options;
  const command = argv.length ? buildBashArgv(argv) : "";

  try {
    const scriptPath = await writeTempScript(
      wrapBashSelfCleanup(`cd "${escapeBash(cwd)}" || exit 1\n${command}\nexec $SHELL`),
      ".sh",
    );

    let tmuxArgs: string[];
    if (newTerminal) {
      tmuxArgs = ["new-window", "-n", windowName, "-c", cwd, "--", "bash", scriptPath];
    } else {
      // split-window as a horizontal pane (tab equivalent in tmux)
      tmuxArgs = ["split-window", "-h", "-c", cwd, "bash", scriptPath];
    }

    const result = Bun.spawnSync(["tmux", ...tmuxArgs]);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.toString().trim() || `tmux ${newTerminal ? "new-window" : "split-window"} failed`,
      };
    }
    await Bun.sleep(150);
    return {
      success: true,
      method: newTerminal ? "new tmux window" : "tmux split pane",
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function openWindowsTerminal(
  cwd: string,
  argv: string[] = [],
  newTerminal: boolean = true,
): Promise<TerminalResult> {
  if (!cwd) return { success: false, error: "Working directory is required" };

  const command = argv.length ? buildBatchArgv(argv) : "";
  const scriptContent = wrapBatchSelfCleanup(
    command
      ? `cd /d "${escapeBatch(cwd)}"\r\n${command}\r\ncmd /k`
      : `cd /d "${escapeBatch(cwd)}"\r\ncmd /k`,
  );

  const scriptPath = await writeTempScript(scriptContent, ".bat");

  try {
    const wtCheck = Bun.spawnSync(["where", "wt"], { stdout: "pipe", stderr: "pipe" });

    if (wtCheck.exitCode === 0) {
      if (newTerminal) {
        const proc = Bun.spawn(["wt.exe", "-d", cwd, "cmd", "/k", scriptPath], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        proc.unref();
      } else {
        // Open in existing Windows Terminal tab
        const proc = Bun.spawn(["wt.exe", "-w", "0", "nt", "-d", cwd, "cmd", "/k", scriptPath], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        proc.unref();
      }
      return { success: true, method: newTerminal ? "new Windows Terminal window" : "Windows Terminal tab" };
    }

    const proc = Bun.spawn(["cmd", "/c", "start", "", scriptPath], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { success: true, method: "new cmd window" };
  } catch (error) {
    await rm(scriptPath, { force: true }).catch(() => {});
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Try to open a tab in the current terminal on Unix.
 * Only called when newTerminal is false and we're not in tmux or SSH.
 */
async function openUnixTab(cwd: string, argv: string[], scriptPath: string): Promise<TerminalResult | null> {
  const detected = await detectParentTerminal();
  const command = argv.length ? buildBashArgv(argv) : "";

  const tabScriptContent = wrapBashSelfCleanup(
    command
      ? `cd "${escapeBash(cwd)}" && ${command}\nexec bash`
      : `cd "${escapeBash(cwd)}"\nexec bash`,
  );

  // Regenerate script with the correct content
  const tabScriptPath = await writeTempScript(tabScriptContent, ".sh");

  interface TabTerminal {
    name: string;
    /** Name(s) returned by detectParentTerminal() that match this terminal. */
    matches: string[];
    envVar?: string;
    args: string[];
  }

  const tabTerminals: TabTerminal[] = [
    {
      name: "gnome-terminal",
      matches: ["gnome-terminal"],
      envVar: "GNOME_TERMINAL_SERVICE",
      args: ["gnome-terminal", "--tab", "--working-directory", cwd, "--", "bash", tabScriptPath],
    },
    {
      name: "konsole",
      matches: ["konsole"],
      envVar: "KONSOLE_VERSION",
      args: ["konsole", "--new-tab", "--workdir", cwd, "-e", "bash", tabScriptPath],
    },
    {
      name: "xfce4-terminal",
      matches: ["xfce4-terminal"],
      args: ["xfce4-terminal", "--tab", "--working-directory", cwd, "-x", "bash", tabScriptPath],
    },
    {
      name: "terminator",
      matches: ["terminator"],
      args: ["terminator", "--new-tab", "-e", "bash", tabScriptPath],
    },
    {
      name: "kgx",
      matches: ["kgx"],
      args: ["kgx", "--tab", "--working-directory", cwd, "--", "bash", tabScriptPath],
    },
  ];

  for (const term of tabTerminals) {
    // Match by parent process comm (strongest signal)
    if (detected && term.matches.includes(detected)) {
      const check = Bun.spawnSync(["which", term.name], { stdout: "pipe", stderr: "pipe" });
      if (check.exitCode !== 0) continue;
      try {
        const proc = Bun.spawn(term.args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
        proc.unref();
        return { success: true, method: `tab in ${term.name}` };
      } catch {
        continue;
      }
    }

    // Fallback: match by env var (weaker signal)
    if (term.envVar && process.env[term.envVar]) {
      const check = Bun.spawnSync(["which", term.name], { stdout: "pipe", stderr: "pipe" });
      if (check.exitCode !== 0) continue;
      try {
        const proc = Bun.spawn(term.args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
        proc.unref();
        return { success: true, method: `tab in ${term.name}` };
      } catch {
        continue;
      }
    }
  }

  // kitty-specific: use IPC instead of CLI
  if (detected === "kitty" || process.env.KITTY_PID) {
    try {
      const kittyCmd = command || `cd "${escapeBash(cwd)}" && exec bash`;
      const proc = Bun.spawn(
        ["kitty", "@", "launch", "--type", "tab", "--cwd", cwd, "--", "bash", "-c", kittyCmd],
        { detached: true, stdio: ["ignore", "ignore", "ignore"] },
      );
      proc.unref();
      return { success: true, method: "tab in kitty" };
    } catch {
      // fall through
    }
  }

  // macOS Terminal.app via osascript
  if (process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal") {
    try {
      // osascript doesn't use the script file; inline the command
      const script = `tell application "Terminal"\n  activate\n  do script "cd ${escapeBash(cwd)} && ${command || "exec bash"}"\nend tell`;
      const proc = Bun.spawn(["osascript", "-e", script], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.unref();
      return { success: true, method: "tab in Terminal.app" };
    } catch {
      // fall through
    }
  }

  await rm(tabScriptPath, { force: true }).catch(() => {});
  return null; // no tab method worked
}

export async function openUnixTerminal(
  cwd: string,
  argv: string[] = [],
  newTerminal: boolean = true,
): Promise<TerminalResult> {
  if (!cwd) return { success: false, error: "Working directory is required" };

  // If not requesting a new terminal window, try tab spawning first
  if (!newTerminal && !isInsideSSH()) {
    const command = argv.length ? buildBashArgv(argv) : "";
    const scriptContent = wrapBashSelfCleanup(
      command
        ? `cd "${escapeBash(cwd)}" && ${command}\nexec bash`
        : `cd "${escapeBash(cwd)}"\nexec bash`,
    );
    const scriptPath = await writeTempScript(scriptContent, ".sh");
    const tabResult = await openUnixTab(cwd, argv, scriptPath);
    if (tabResult && tabResult.success) {
      return tabResult;
    }
    // Tab failed; log via the result method field
  }

  // Fall back to new-window behavior
  const command = argv.length ? buildBashArgv(argv) : "";
  const scriptContent = wrapBashSelfCleanup(
    command
      ? `cd "${escapeBash(cwd)}" && ${command}\nexec bash`
      : `cd "${escapeBash(cwd)}"\nexec bash`,
  );
  const scriptPath = await writeTempScript(scriptContent, ".sh");

  const attempts: Array<{ name: string; args: string[] }> = [
    { name: "xdg-terminal-exec", args: ["xdg-terminal-exec", "--", "bash", scriptPath] },
    { name: "gnome-terminal", args: ["gnome-terminal", "--working-directory", cwd, "--", "bash", scriptPath] },
    { name: "kitty", args: ["kitty", "--directory", cwd, "-e", "bash", scriptPath] },
    { name: "open", args: ["open", "-a", "Terminal", scriptPath] },
  ];

  for (const { name, args } of attempts) {
    const check = Bun.spawnSync(["which", name], { stdout: "pipe", stderr: "pipe" });
    if (check.exitCode !== 0) continue;
    try {
      const proc = Bun.spawn(args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
      proc.unref();
      return { success: true, method: `new ${name} window` };
    } catch {
      // try next terminal
    }
  }

  await rm(scriptPath, { force: true }).catch(() => {});
  return { success: false, error: "No supported terminal emulator found" };
}

export async function openTerminal(
  cwd: string,
  argv: string[] = [],
  windowName?: string,
  newTerminal: boolean = true,
): Promise<TerminalResult> {
  if (isInsideTmux()) {
    return openTmuxWindow({ windowName: windowName ?? "worktree", cwd, argv, newTerminal });
  }

  if (process.platform === "win32") {
    return openWindowsTerminal(cwd, argv, newTerminal);
  }

  return openUnixTerminal(cwd, argv, newTerminal);
}

export function buildOpenCodeLaunchArgv(worktreePath: string): string[] {
  return ["opencode", worktreePath];
}
