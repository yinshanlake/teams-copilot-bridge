import type { ReplyGroupPresentation, ReplyPresentation } from "./domain.js";
import { chunkText, safeText } from "./safety.js";
import { escapedDisplayHtml } from "./transport-format.js";

function titleText(title: string): string {
  return safeText(title, 120).replace(/[\r\n\u2028\u2029]/gu, " ")
    .replace(/[\\`*_{}\[\]()#+.!|<>~&=-]/gu, "\\$&");
}

export function replyHeader(presentation: ReplyPresentation): string {
  if (presentation.version === 3 || presentation.version === 4) {
    const history = presentation.kind === "history";
    const background = presentation.kind === "background";
    const plain = presentation.format !== "markdown";
    const title = plain ? safeText(presentation.title, 440).replace(/[\r\n\u2028\u2029]/gu, " ") : titleText(presentation.title);
    const source = history || background ? presentation.sourceId : presentation.sourceId.slice(0, 8);
    const heading = `${history ? "HISTORY · " : ""}${title}${plain && presentation.part === 1 ? " · Plain text" : ""}`;
    return `${plain ? heading : `**${heading}**`} · ${source}\n\n` +
      (history ? "Read-only history snapshot · not a new Copilot reply\n\n" : background ? "Background reply\n\n"
        : presentation.kind === "control" ? "Control reply\n\n" : "") +
      (presentation.parts > 1 ? `Group ${presentation.groupId.slice(0, 8)} · ${presentation.part}/${presentation.parts}\n\n` : "");
  }
  const context = presentation.kind === "background" ? "Background reply"
    : presentation.kind === "control" ? "Control reply" : "";
  const continuation = presentation.parts > 1
    ? `Reply ${presentation.groupId.slice(0, 8)} · ${presentation.part}/${presentation.parts}` : "";
  return `**${titleText(presentation.title)}**\n\n` +
    ([context, continuation].filter(Boolean).join(" · ") || "") +
    (context || continuation ? "\n\n" : "");
}

export function replyChunks(text: string, presentation: ReplyGroupPresentation): Array<{
  text: string; presentation: ReplyPresentation;
}> {
  if (presentation.version === 4) {
    // Reserve worst-case counters; measure the same fields used by the adapter.
    const counters = [1, Number.MAX_SAFE_INTEGER].map((part) => ({
      ...presentation, part, parts: Number.MAX_SAFE_INTEGER,
    }));
    const wireBytes = (body: string, metadata: ReplyPresentation) =>
      Buffer.byteLength(JSON.stringify({ type: "message", ...replyActivityFields({ text: body, presentation: metadata }) }));
    const reserved = counters.sort((a, b) => wireBytes("", b) - wireBytes("", a))[0]!;
    const boundaries = [0];
    for (let offset = 0; offset < text.length;) {
      offset += text[offset] === "\r" && text[offset + 1] === "\n" ? 2 : text.codePointAt(offset)! > 0xffff ? 2 : 1;
      boundaries.push(offset);
    }
    const chunks: string[] = [];
    for (let start = 0; start + 1 < boundaries.length;) {
      let end = start;
      let lower = start + 1;
      let upper = Math.min(boundaries.length - 1, start + 12_000);
      while (lower <= upper) {
        const candidate = Math.floor((lower + upper) / 2);
        if (wireBytes(text.slice(boundaries[start], boundaries[candidate]), reserved) <= 12_000) {
          end = candidate;
          lower = candidate + 1;
        } else upper = candidate - 1;
      }
      if (end === start) throw new Error("Reply header leaves no wire budget for a source character");
      chunks.push(text.slice(boundaries[start], boundaries[end]));
      start = end;
    }
    return chunks.map((body, index) => {
      const metadata = { ...presentation, part: index + 1, parts: chunks.length };
      if (wireBytes(body, metadata) > 12_000) throw new Error("Formatted Activity JSON exceeds its wire budget");
      return { text: body, presentation: metadata };
    });
  }
  // Persisted v2/v3 groups retain their original text-byte splitting policy.
  const reserve = Math.max(...[1, Number.MAX_SAFE_INTEGER].map((part) =>
    Buffer.byteLength(replyHeader({ ...presentation, part, parts: Number.MAX_SAFE_INTEGER }))));
  const chunks = chunkText(text, 12_000 - reserve);
  return chunks.map((text, index) => ({
    text, presentation: { ...presentation, part: index + 1, parts: chunks.length },
  }));
}

export function replyText(message: { text: string; presentation?: ReplyPresentation }): string {
  const text = message.presentation ? replyHeader(message.presentation) + message.text : message.text;
  return message.presentation?.version === 4 && message.presentation.format === "xml" ? escapedDisplayHtml(text) : text;
}

export function replyActivityFields(message: { text: string; presentation?: ReplyPresentation }): {
  text: string; textFormat: "plain" | "markdown" | "extendedmarkdown" | "xml";
} {
  return {
    text: replyText(message),
    textFormat: message.presentation?.version === 3 || message.presentation?.version === 4 ? message.presentation.format
      : message.presentation ? "extendedmarkdown" : "plain",
  };
}
