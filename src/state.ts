import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectId } from "./project-id";

export interface WorktreeSession {
  id: string;
  branch: string;
  path: string;
  createdAt: string;
}

export interface PendingDelete {
  branch: string;
  path: string;
}

function getDbDirectory(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "plugins", "worktree");
}

async function getDbPath(projectRoot: string): Promise<string> {
  const projectId = await getProjectId(projectRoot);
  return path.join(getDbDirectory(), `${projectId}.sqlite`);
}

export async function initStateDb(projectRoot: string): Promise<Database> {
  const dbPath = await getDbPath(projectRoot);
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_operations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      type TEXT NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL
    )
  `);

  return db;
}

export function addSession(db: Database, session: WorktreeSession): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, branch, path, created_at)
    VALUES ($id, $branch, $path, $createdAt)
  `);
  stmt.run({
    $id: session.id,
    $branch: session.branch,
    $path: session.path,
    $createdAt: session.createdAt,
  });
}

export function getSession(db: Database, sessionId: string): WorktreeSession | null {
  if (!sessionId) return null;
  const row = db
    .prepare(`SELECT id, branch, path, created_at as createdAt FROM sessions WHERE id = $id`)
    .get({ $id: sessionId }) as WorktreeSession | null;
  return row ?? null;
}

export function getAllSessions(db: Database): WorktreeSession[] {
  return db
    .prepare(`SELECT id, branch, path, created_at as createdAt FROM sessions ORDER BY created_at ASC`)
    .all() as WorktreeSession[];
}

/** Look up a worktree session by its worktree path. */
export function getSessionByPath(db: Database, path: string): WorktreeSession | null {
  if (!path) return null;
  const row = db
    .prepare(`SELECT id, branch, path, created_at as createdAt FROM sessions WHERE path = $path`)
    .get({ $path: path }) as WorktreeSession | null;
  return row ?? null;
}

export function removeSession(db: Database, branch: string): void {
  if (!branch) return;
  db.prepare(`DELETE FROM sessions WHERE branch = $branch`).run({ $branch: branch });
}

export function setPendingDelete(db: Database, del: PendingDelete): void {
  db.prepare(`
    INSERT OR REPLACE INTO pending_operations (id, type, branch, path)
    VALUES (1, 'delete', $branch, $path)
  `).run({ $branch: del.branch, $path: del.path });
}

export function getPendingDelete(db: Database): PendingDelete | null {
  const row = db
    .prepare(`SELECT branch, path FROM pending_operations WHERE id = 1 AND type = 'delete'`)
    .get() as PendingDelete | null;
  return row ?? null;
}

export function clearPendingDelete(db: Database): void {
  db.prepare(`DELETE FROM pending_operations WHERE id = 1 AND type = 'delete'`).run();
}