import type { BridgeState, FollowPreference, SessionRecord, TimelineEntry } from "./domain.js";
import { chronologicalTimeline } from "./projection.js";
import { digest } from "./safety.js";

export function follows(state: BridgeState, key: string, sessionId: string, now = Date.now()): FollowPreference | undefined {
  const preference = state.interaction?.follows[digest(`${key}:${sessionId}`)];
  return preference && preference.mode !== "muted" &&
    (preference.expiresAt === undefined || preference.expiresAt > now) ? preference : undefined;
}

export function canFollow(session: SessionRecord | undefined): boolean {
  return session !== undefined && session.access?.read !== false && (session.kind === "owned" || session.peerSource === "app");
}

export function followDescription(state: BridgeState, key: string, sessionId: string, now = Date.now()): string {
  const preference = state.interaction?.follows[digest(`${key}:${sessionId}`)];
  if (!preference) return "Not subscribed. Direct task replies still arrive.";
  if (preference.mode === "muted") return preference.explicitMute === true
    ? "Unsubscribed by you. New tasks will not enable notifications; direct task replies still arrive."
    : preference.explicitMute === undefined ? "Not subscribed (saved preference). Subscribe to enable notifications; direct replies still arrive."
      : "Automatic subscription expired. Direct task replies still arrive.";
  if (preference.expiresAt !== undefined && preference.expiresAt <= now) return "Automatic subscription expired. Direct task replies still arrive.";
  const subscription = state.subscriptions[preference.id];
  if (subscription?.enabled && subscription.status === "paused") return `Subscription paused: ${subscription.detail}`;
  if (preference.observation === "unavailable") return `Subscription unavailable: ${preference.detail}`;
  const duration = preference.mode === "explicit" ? "no expiry"
    : `${Math.max(1, Math.ceil(((preference.expiresAt ?? now) - now) / 3_600_000))} hr left`;
  return preference.observation === "live"
    ? `Subscribed (${duration}) - live only; no offline catch-up or automatic reconnect.`
    : `Subscribed (${duration}) - from the saved journal cursor.`;
}

export function notificationLabel(state: BridgeState, key: string, sessionId: string, now = Date.now()): string {
  const active = follows(state, key, sessionId, now);
  if (!active) return canFollow(state.sessions[sessionId]) ? "Not subscribed" : "Subscription unavailable";
  const subscription = state.subscriptions[active.id];
  return subscription?.enabled && subscription.status === "paused" ? "Subscription paused"
    : active.observation === "unavailable" ? "Subscription unavailable"
      : active.observation === "live" ? "Subscribed - live only" : "Subscribed";
}

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
