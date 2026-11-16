import type { SessionRecord, TimelineEntry } from "./domain.js";
import { chronologicalTimeline } from "./projection.js";

export function conversationDialogue(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return chronologicalTimeline(entries.filter((entry) => entry.text.trim() &&
    (entry.kind === "user" || entry.kind === "assistant" && entry.phase !== "commentary" && entry.state !== "running")));
}

export function sourceTitle(session: SessionRecord, sessions: Record<string, SessionRecord>): string {
  if (!session.sideChat) return session.name;
  const parent = sessions[session.sideChat.parentId ?? ""];
  if (parent && session.name.startsWith(`${parent.name} > `)) return session.name;
  return `${parent?.name ?? "Unknown parent"} > Side chat ${session.id.slice(0, 8)} · ${session.name}`;
}
