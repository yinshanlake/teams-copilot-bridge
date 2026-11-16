// The compatibility renderer must never interpret local references or raw tags.
// Fall back for the whole new group, rather than rewriting Markdown or code.
export function newMessageFormat(text: string): "markdown" | "plain" {
  if (text.includes("<")) return "plain";
  const http = (target: string) => {
    if (/[\s\\\u0000-\u001f]/u.test(target)) return false;
    try {
      const url = new URL(target);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    } catch { return false; }
  };
  let lineStart = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") { lineStart = index + 1; continue; }
    if (text[index] === "\\") { index++; continue; }
    if (text[index] !== "]") continue;
    if (text[index + 1] === "(") {
      let end = index + 2;
      let depth = 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === "\\") { end++; continue; }
        if (text[end] === "(") depth++;
        if (text[end] === ")") depth--;
      }
      if (depth || !http(text.slice(index + 2, end - 1).trim())) return "plain";
      index = end - 1;
    } else if (text[index + 1] === ":") {
      if (!/^[ \t]{0,3}\[/u.test(text.slice(lineStart, lineStart + 4))) continue;
      const end = text.indexOf("\n", index);
      if (!http(text.slice(index + 2, end < 0 ? text.length : end).trim())) return "plain";
    }
  }
  return "markdown";
}

export function escapedDisplayHtml(text: string): string {
  return text.replace(/\r\n|[\r\n&<>"'\t ]/gu, (value: string, offset: number) => {
    switch (value) {
      case "\r\n": case "\r": case "\n": return "<br>";
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      case "\t": return "&#160;".repeat(4);
      case " ": return offset === 0 || /[ \t\r\n]/u.test(text[offset - 1]!) ? "&#160;" : " ";
      default: throw new Error("Unexpected HTML display character");
    }
  });
}
