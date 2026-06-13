type JsonObject = { readonly [key: string]: unknown };

const DEFAULT_MAX_ITEMS = 10;
const AGENT_MESSAGE_MAX_CHARS = 120;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerField(record: JsonObject, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function commandName(item: JsonObject): string {
  const command = item.command;
  if (typeof command === "string" && command.trim() !== "") {
    return command.trim();
  }
  if (
    Array.isArray(command) &&
    command.every((part): part is string => typeof part === "string")
  ) {
    const joined = command.join(" ").trim();
    if (joined !== "") return joined;
  }
  if (isJsonObject(command) && typeof command.name === "string") {
    const name = command.name.trim();
    if (name !== "") return name;
  }
  const commandNameValue = item.command_name;
  if (typeof commandNameValue === "string" && commandNameValue.trim() !== "") {
    return commandNameValue.trim();
  }
  const name = item.name;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  return "(unknown)";
}

function exitCode(item: JsonObject): string {
  const snake = item.exit_code;
  if (typeof snake === "number" && Number.isInteger(snake)) {
    return String(snake);
  }
  const camel = item.exitCode;
  if (typeof camel === "number" && Number.isInteger(camel)) {
    return String(camel);
  }
  return "unknown";
}

function oneLinePrefix(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, AGENT_MESSAGE_MAX_CHARS);
}

function summarizeItemCompleted(event: JsonObject): string | null {
  if (!isJsonObject(event.item)) return null;
  if (event.item.type === "command_execution") {
    return `item.completed command_execution command="${commandName(event.item)}" exit_code=${exitCode(event.item)}`;
  }
  if (event.item.type === "agent_message") {
    const text = typeof event.item.text === "string" ? event.item.text : "";
    return `item.completed agent_message: ${oneLinePrefix(text)}`;
  }
  return null;
}

function summarizeTurnCompleted(event: JsonObject): string | null {
  if (!isJsonObject(event.usage)) return null;
  const input = integerField(event.usage, "input_tokens");
  const cachedInput = integerField(event.usage, "cached_input_tokens");
  const output = integerField(event.usage, "output_tokens");
  const reasoningOutput = integerField(event.usage, "reasoning_output_tokens");
  if (
    input === null ||
    cachedInput === null ||
    output === null ||
    reasoningOutput === null
  ) {
    return null;
  }
  return (
    `turn.completed usage input=${input} cached_input=${cachedInput} ` +
    `output=${output} reasoning_output=${reasoningOutput} ` +
    `total=${input + output}`
  );
}

function summarizeLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return "(unparseable line)";
  }
  if (!isJsonObject(parsed)) return null;
  if (parsed.type === "item.completed") return summarizeItemCompleted(parsed);
  if (parsed.type === "turn.completed") return summarizeTurnCompleted(parsed);
  return null;
}

export function summarizeCodexEvents(
  content: string,
  opts: { maxItems?: number } = {},
): string {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  if (maxItems <= 0) return "";
  const items = content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => summarizeLine(line))
    .filter((line): line is string => line !== null);
  if (items.length === 0) return "";
  return items
    .slice(-maxItems)
    .map((line) => `- ${line}`)
    .join("\n");
}
