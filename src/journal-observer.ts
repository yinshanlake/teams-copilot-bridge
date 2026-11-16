import { createReadStream, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FinalPage, JournalCursor } from "./domain.js";
import type { AppSessionTurn } from "./app-sessions.js";
import { digest, object, safeText, string, UserError } from "./safety.js";
import { originAgrees, publishedMessage, visibleArgument, visibleTool, type VisibleTool } from "./visible-publication.js";

export function appJournalEvent(id: string, turn: AppSessionTurn, historical = false): Record<string, unknown> {
  const messageId = digest(`app:${id}:${turn.index}:${turn.timestamp}`).slice(0, 32);
  return {
    id: `${historical ? "app-history" : "app-result"}:${messageId}`,
    type: turn.role === "user" ? "user.message" : "assistant.message", timestamp: turn.timestamp,
    data: { messageId, phase: turn.phase ?? "final", content: safeText(turn.assistantResponse, 8000),
      ...(turn.originatingMessageId && !turn.role && !turn.phase ? {
        sourceResultKey: digest(`app:${id}:${turn.originatingMessageId}:${safeText(turn.assistantResponse, 8000)}`),
      } : {}),
      ...(turn.originatingMessageId ? { originatingMessageId: turn.originatingMessageId } : {}) },
  };
}

const generation = (file: Stats) => `${file.dev}:${file.ino}:${file.birthtimeMs}`;
async function anchor(path: string, offset: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min(offset, 256));
    const read = await file.read(bytes, 0, bytes.length, offset - bytes.length);
    if (read.bytesRead !== bytes.length) throw new UserError("SUBSCRIPTION_JOURNAL_CHANGED");
    return digest(bytes.toString("hex"));
  } finally { await file.close(); }
}
async function header(path: string, bytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = await file.read(buffer, 0, bytes, 0);
    if (read.bytesRead !== bytes) throw new UserError("SUBSCRIPTION_JOURNAL_CHANGED");
    return digest(buffer.toString("hex"));
  } finally { await file.close(); }
}

async function* lines(path: string, start: number, end: number, discarding: boolean): AsyncGenerator<
  { kind: "record"; text: string | undefined; endOffset: number; terminated: boolean } |
  { kind: "discard"; endOffset: number } | { kind: "boundary" }
> {
  let parts: Buffer[] = [];
  let size = 0;
  let position = start;
  let oversized = discarding;
  const readEnd = Math.min(end, start + 8 * 1024 * 1024 - 1);
  const input = createReadStream(path, { start, end: readEnd, highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk)) throw new UserError("SUBSCRIPTION_BYTE_STREAM");
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(10, from);
        const part = chunk.subarray(from, newline < 0 ? chunk.length : newline);
        size += part.length;
        position += part.length;
        if (size > 4 * 1024 * 1024) { oversized = true; parts = []; }
        else if (!oversized) parts.push(part);
        if (newline < 0) break;
        position++;
        yield { kind: "record", text: oversized ? undefined : Buffer.concat(parts).toString("utf8"), endOffset: position, terminated: true };
        size = 0; parts = []; oversized = false; from = newline + 1;
      }
    }
    if (oversized) yield { kind: "discard", endOffset: position };
    else if (size && readEnd === end) yield { kind: "record", text: Buffer.concat(parts).toString("utf8"), endOffset: position, terminated: false };
    else if (size) yield { kind: "boundary" };
  } finally { input.destroy(); }
}

function correlation(event: Record<string, unknown>, key: string): string | undefined {
  const nested = object(event.data) ? event.data[key] : undefined;
  if (nested !== undefined && event[key] !== undefined && nested !== event[key]) return undefined;
  const value = nested ?? event[key];
  return string(value, 512) ? value : undefined;
}
function summaryHash(value: unknown, name: VisibleTool = "task_complete"): string | undefined {
  const text = visibleArgument(name, value);
  return text === undefined ? undefined : digest(text);
}

export async function journalPage(sessionId: string, path: string, from?: JournalCursor): Promise<FinalPage> {
  const file = await stat(path);
  const cursor: JournalCursor = from ? structuredClone(from) : {
    generation: generation(file), offset: 0, index: 0, anchor: await anchor(path, 0),
    headerBytes: Math.min(256, file.size), header: await header(path, Math.min(256, file.size)),
    eofRecord: false, requests: [], starts: [], outputs: [],
  };
  const scanned = cursor.discard?.offset ?? cursor.offset;
  if (cursor.generation !== generation(file) || file.size < scanned || cursor.anchor !== await anchor(path, cursor.offset) ||
    cursor.discard && cursor.discard.anchor !== await anchor(path, cursor.discard.offset) ||
    cursor.header !== undefined && cursor.header !== await header(path, cursor.headerBytes ?? 0)) {
    throw new UserError("SUBSCRIPTION_JOURNAL_CHANGED: identity/truncation changed; observation is paused, not reset.");
  }
  const events: unknown[] = [];
  if (file.size === scanned) return { cursor, events, hasMore: false };
  if (cursor.eofRecord) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(2);
      const read = await handle.read(buffer, 0, 2, cursor.offset);
      const separator = buffer.subarray(0, read.bytesRead).toString("utf8");
      if (separator.startsWith("\r\n")) cursor.offset += 2;
      else if (separator.startsWith("\n")) cursor.offset++;
      else if (separator === "\r") return { cursor, events, hasMore: false };
      else throw new UserError("SUBSCRIPTION_UNTERMINATED_RECORD_CHANGED");
      cursor.eofRecord = false;
    } finally { await handle.close(); }
  }
  const start = cursor.offset;
  let records = 0;
  let incomplete = false;
  const output = (event: Record<string, unknown>, content: string, origin?: string) => {
    if (!string(event.timestamp, 64) || !Number.isFinite(Date.parse(event.timestamp)) || !content.trim()) return;
    const key = digest(JSON.stringify([origin ?? "", origin ? "" : correlation(event, "turnId") ?? "", origin ? "" : correlation(event, "interactionId") ?? "", safeText(content, 8000)]));
    if (cursor.outputs.some((entry) => entry.key === key)) return;
    cursor.outputs.push({ key, index: cursor.index, timestamp: event.timestamp });
    cursor.outputs = cursor.outputs.slice(-256);
    events.push(appJournalEvent(sessionId, { index: cursor.index, timestamp: event.timestamp, assistantResponse: content,
      ...(origin ? { originatingMessageId: origin } : {}) }));
  };
  const readStart = cursor.discard?.offset ?? cursor.offset;
  if (readStart < file.size) for await (const record of lines(path, readStart, file.size - 1, cursor.discard !== undefined)) {
    if (record.kind === "boundary") break;
    if (record.kind === "discard") {
      // Discard progress is durable, but the physical record stays uncovered
      // until its newline is observed, including across page and EOF boundaries.
      cursor.discard = { offset: record.endOffset, anchor: await anchor(path, record.endOffset) };
      break;
    }
    let event: unknown;
    try { if (record.text !== undefined) event = JSON.parse(record.text); } catch {
      if (!record.terminated) { incomplete = true; break; }
    }
    if (record.text === undefined && !record.terminated) { incomplete = true; break; }
    if (object(event) && object(event.data) && !event.agentId && !event.data.parentToolCallId && event.checkpoint !== true) {
      const data = event.data;
      if (["session.start", "session.resume", "session.shutdown", "abort"].includes(String(event.type))) {
        cursor.requests = []; cursor.starts = [];
      }
      if (event.type === "session.start" && data.sessionId !== undefined &&
        (typeof data.sessionId !== "string" || data.sessionId.toLowerCase() !== sessionId.toLowerCase())) {
        throw new UserError("APP_HISTORY_IDENTITY_MISMATCH");
      }
      if (event.type === "assistant.message" && (data.phase === undefined || ["commentary", "final", "final_answer", "response"].includes(String(data.phase)))) {
        const origin = correlation(event, "originatingMessageId");
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        for (const request of requests) {
          if (!object(request) || !visibleTool(request.name) || !string(request.toolCallId, 200) || !string(event.id, 200)) continue;
          if (request.name === "publish_chat_update" && !originAgrees(event, origin)) continue;
          const hash = summaryHash(request.arguments, request.name);
          const turnId = correlation(event, "turnId");
          const interactionId = correlation(event, "interactionId");
          if (!hash || !turnId || !interactionId) continue;
          cursor.requests = cursor.requests.filter((item) => item.toolCallId !== request.toolCallId);
          cursor.starts = cursor.starts.filter((id) => id !== request.toolCallId);
          cursor.requests.push({ toolCallId: request.toolCallId, toolName: request.name, summaryHash: hash, messageEventId: event.id, turnId, interactionId,
            ...(origin ? { origin } : {}) });
          if (cursor.requests.length > 32) throw new UserError("SUBSCRIPTION_CONTEXT_LIMIT");
        }
        if (!requests.length && data.phase !== "commentary" && typeof data.content === "string") output(event, data.content, origin);
      }
      if (event.type === "tool.execution_start") {
        const request = cursor.requests.find((item) => item.toolCallId === data.toolCallId);
        if (request && data.toolName === (request.toolName ?? "task_complete") &&
          (event.parentId === request.messageEventId || request.toolName === "publish_chat_update" && event.parentId === undefined) &&
          correlation(event, "turnId") === request.turnId && summaryHash(data.arguments, request.toolName) === request.summaryHash &&
          originAgrees(event, request.origin)) {
          if (!cursor.starts.includes(request.toolCallId)) cursor.starts.push(request.toolCallId);
        }
      }
      if (event.type === "tool.execution_complete") {
        const request = cursor.requests.find((item) => item.toolCallId === data.toolCallId);
        const rawContent = object(data.result) ? data.result.content : undefined;
        const content = request?.toolName === "publish_chat_update" ? publishedMessage(rawContent) : rawContent;
        if (request && cursor.starts.includes(request.toolCallId) && data.success === true && typeof content === "string" &&
          digest(content) === request.summaryHash && correlation(event, "turnId") === request.turnId &&
          correlation(event, "interactionId") === request.interactionId &&
          originAgrees(event, request.origin)) {
          output(event, content, request.origin);
        }
        cursor.requests = cursor.requests.filter((item) => item.toolCallId !== data.toolCallId);
        cursor.starts = cursor.starts.filter((id) => id !== data.toolCallId);
      }
    }
    cursor.offset = record.endOffset;
    delete cursor.discard;
    cursor.index++;
    cursor.eofRecord = !record.terminated;
    records++;
    if (records >= 128 || cursor.offset - start >= 1024 * 1024 || events.length >= 16) break;
  }
  const after = await stat(path);
  const coveredOrScanned = cursor.discard?.offset ?? cursor.offset;
  if (generation(after) !== cursor.generation || after.size < coveredOrScanned ||
    cursor.header !== undefined && cursor.header !== await header(path, cursor.headerBytes ?? 0)) throw new UserError("SUBSCRIPTION_JOURNAL_CHANGED");
  cursor.anchor = await anchor(path, cursor.offset);
  return { cursor, events, hasMore: !incomplete && coveredOrScanned < file.size };
}

export async function journalBaseline(sessionId: string, path: string): Promise<JournalCursor> {
  let cursor: JournalCursor | undefined;
  for (let count = 0; count < 10_000; count++) {
    const page = await journalPage(sessionId, path, cursor);
    cursor = page.cursor;
    if ((cursor.discard?.offset ?? cursor.offset) > 256 * 1024 * 1024) throw new UserError("SUBSCRIPTION_BASELINE_LIMIT");
    if (!page.hasMore) return cursor;
  }
  throw new UserError("SUBSCRIPTION_BASELINE_LIMIT");
}
