import { object, string } from "./safety.js";

export type VisibleTool = "task_complete" | "publish_chat_update";
export function visibleTool(value: unknown): value is VisibleTool {
  return value === "task_complete" || value === "publish_chat_update";
}
export function visibleArgument(name: VisibleTool, value: unknown): string | undefined {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
  const text = object(value) ? value[name === "task_complete" ? "summary" : "message"] : undefined;
  return typeof text === "string" && text.trim() && text.length <= 120_000 ? text : undefined;
}
export function publishedMessage(content: unknown): string | undefined {
  if (typeof content !== "string" || content.length > 4 * 1024 * 1024) return undefined;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return undefined; }
  return object(value) && value.kind === "chat_update" && value.version === 1 && Array.isArray(value.attachments) &&
    typeof value.message === "string" && value.message.trim() && value.message.length <= 120_000 ? value.message : undefined;
}
export function originAgrees(event: Record<string, unknown>, expected: string | undefined): boolean {
  const nested = object(event.data) ? event.data.originatingMessageId : undefined;
  const root = event.originatingMessageId;
  if (nested === undefined && root === undefined) return true;
  if (nested !== undefined && root !== undefined && nested !== root) return false;
  const value = nested ?? root;
  return string(value, 512) && value === expected;
}
