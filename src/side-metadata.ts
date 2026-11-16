import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalId, object, safeText, UserError } from "./safety.js";

export interface SideRelation { id: string; parentId?: string; title?: string; parentName?: string }
export interface SideMetadata { available: boolean; detail: string; sides: SideRelation[] }

const columns: Record<string, string[]> = {
  workspace_side_chats: ["workspace_id", "session_id", "created_at"],
  session_side_chats: ["parent_session_id", "session_id", "created_at"],
  workspaces: ["id", "session_id", "name", "archived_at"],
  sessions: ["id", "title", "session_type", "is_running", "was_interrupted", "created_at", "updated_at", "archived_at"],
};

export async function readSideMetadata(path?: string, loadSQLite: () => Promise<typeof import("node:sqlite")> = () => import("node:sqlite")): Promise<SideMetadata> {
  if (!path) return { available: false, detail: "Side-chat metadata is not configured. Set COPILOT_APP_METADATA_DB explicitly.", sides: [] };
  let db: DatabaseSync | undefined;
  try {
    if (!isAbsolute(path)) throw new UserError("METADATA_PATH");
    const expected = resolve(path);
    for (let part = expected; ; part = dirname(part)) {
      if ((await lstat(part)).isSymbolicLink()) throw new UserError("METADATA_PATH");
      if (dirname(part) === part) break;
    }
    const actual = await realpath(expected);
    const file = await stat(actual);
    if (!file.isFile() || file.size > 512 * 1024 * 1024) throw new UserError("METADATA_PATH");
    let sqlite: typeof import("node:sqlite");
    try { sqlite = await loadSQLite(); } catch (error) {
      if (object(error) && ["ERR_UNKNOWN_BUILTIN_MODULE", "ERR_MODULE_NOT_FOUND"].includes(String(error.code))) {
        return { available: false, detail: "Side-chat discovery needs a Node version with built-in read-only SQLite.", sides: [] };
      }
      throw error;
    }
    if (typeof sqlite.DatabaseSync !== "function") throw new UserError("SQLITE_UNAVAILABLE");
    db = new sqlite.DatabaseSync(actual, { readOnly: true, timeout: 1000, enableForeignKeyConstraints: false });
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('workspace_side_chats','session_side_chats','workspaces','sessions')").all();
    if (tables.length !== 4) throw new UserError("METADATA_SCHEMA");
    for (const [table, required] of Object.entries(columns)) {
      const fields = db.prepare(`PRAGMA table_info(${table})`).all();
      if (required.some((name) => !fields.some((field) => field.name === name))) throw new UserError("METADATA_SCHEMA");
    }
    db.exec("BEGIN");
    const workspaces = db.prepare("SELECT id, session_id, substr(name,1,100) AS name FROM workspaces WHERE archived_at IS NULL AND session_id IS NOT NULL LIMIT 2001").all();
    const sessions = db.prepare("SELECT id, substr(title,1,100) AS title, session_type FROM sessions WHERE archived_at IS NULL AND session_type = 'side_chat' LIMIT 2001").all();
    const workspaceLinks = db.prepare("SELECT workspace_id, session_id FROM workspace_side_chats LIMIT 2001").all();
    const sessionLinks = db.prepare("SELECT parent_session_id, session_id FROM session_side_chats LIMIT 2001").all();
    if ([workspaces, sessions, workspaceLinks, sessionLinks].some((rows) => rows.length > 2000)) throw new UserError("METADATA_LIMIT");
    const parents = new Map<string, { id: string; name?: string }>();
    for (const row of workspaces) {
      if (!canonicalId(row.id) || !canonicalId(row.session_id)) throw new UserError("METADATA_ID");
      parents.set(row.id.toLowerCase(), { id: row.session_id.toLowerCase(), ...(typeof row.name === "string" ? { name: safeText(row.name, 100) } : {}) });
    }
    const relations = new Map<string, SideRelation>();
    for (const row of sessions) {
      if (!canonicalId(row.id)) throw new UserError("METADATA_ID");
      relations.set(row.id.toLowerCase(), { id: row.id.toLowerCase(),
        ...(typeof row.title === "string" && row.title.trim() ? { title: safeText(row.title.trim(), 100) } : {}) });
    }
    const link = (child: unknown, parent: unknown, name?: string) => {
      if (!canonicalId(child) || !canonicalId(parent) || child.toLowerCase() === parent.toLowerCase()) throw new UserError("METADATA_ID");
      const side = relations.get(child.toLowerCase());
      if (!side) return;
      if (side.parentId && side.parentId !== parent.toLowerCase()) throw new UserError("METADATA_AMBIGUOUS_PARENT");
      side.parentId = parent.toLowerCase();
      if (name) side.parentName = name;
    };
    for (const row of workspaceLinks) {
      if (!canonicalId(row.workspace_id) || !canonicalId(row.session_id)) throw new UserError("METADATA_ID");
      const parent = parents.get(row.workspace_id.toLowerCase());
      if (parent) link(row.session_id, parent.id, parent.name);
    }
    for (const row of sessionLinks) link(row.session_id, row.parent_session_id);
    for (const side of relations.values()) {
      const visited = new Set([side.id]);
      let parent = side.parentId;
      while (parent) {
        if (visited.has(parent)) throw new UserError("METADATA_PARENT_CYCLE");
        visited.add(parent);
        parent = relations.get(parent)?.parentId;
      }
    }
    return { available: true, detail: "Side-chat relations read from the explicitly configured read-only metadata database.", sides: [...relations.values()] };
  } catch (error) {
    const code = error instanceof UserError ? error.message : "METADATA_UNAVAILABLE";
    return { available: false, detail: `Side-chat discovery unavailable (${code}). Ordinary session discovery remains available.`, sides: [] };
  } finally { db?.close(); }
}
