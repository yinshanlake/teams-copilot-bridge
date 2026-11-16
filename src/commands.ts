import { UserError } from "./safety.js";

type SimpleCommand = "help" | "sessions" | "status" | "subscribe" | "unsubscribe" |
  "home" | "working" | "needs-reply" | "subscriptions" | "sides" | "new" | "settings" | "read" | "stop";
export type Command = { name: SimpleCommand } | { name: "use"; target: string } |
  { name: "history"; count: number } | { name: "control"; instruction?: string };

const simple = new Set<SimpleCommand>([
  "help", "sessions", "status", "subscribe", "unsubscribe", "home", "working", "needs-reply",
  "subscriptions", "sides", "new", "settings", "read", "stop",
]);

export function parseCommand(text: string): Command | undefined {
  const command = text.trim();
  if (!command.startsWith("!")) return undefined;
  const match = /^!([a-z-]+)(?:\s+([\s\S]*))?$/iu.exec(command);
  if (!match) throw new UserError("Malformed ! command. Use !help. Nothing was forwarded.");
  const name = match[1]!.toLowerCase();
  const argument = match[2]?.trim();
  if (name === "use" && argument && argument.length <= 220 && !/[\r\n]/u.test(argument)) return { name, target: argument };
  if (name === "history" && (argument === undefined || /^(?:[1-9]|[1-4]\d|50)$/u.test(argument))) {
    return { name, count: argument === undefined ? 10 : Number(argument) };
  }
  if (name === "control") {
    const instruction = /^!control[ \t]([\s\S]*)$/iu.exec(text.trimStart())?.[1];
    if (instruction !== undefined && !instruction.trim()) throw new UserError("Enter an explicit management instruction after !control.");
    return { name, ...(instruction === undefined ? {} : { instruction }) };
  }
  if (simple.has(name as SimpleCommand) && argument === undefined) return { name: name as SimpleCommand };
  throw new UserError("Unknown or malformed ! command. Use !use <name or ID>, !history [1..50], or !help. Nothing was forwarded.");
}
