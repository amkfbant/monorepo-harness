import { basename } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { redactCodexEvents } from "./redact-events.js";

export interface CodexEventsIo {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, content: string) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  rm?: (path: string) => Promise<void>;
}

export interface PublishCodexEventsResult {
  redactedCount: number;
  droppedCount: number;
  failed: boolean;
}

const CODEX_EVENTS_REDACTION_FAILED = "redaction.failed";

function defaultCodexEventsIo(
  overrides?: CodexEventsIo,
): Required<CodexEventsIo> {
  return {
    readFile:
      overrides?.readFile ??
      (async (path: string) => await readFile(path, "utf8")),
    writeFile:
      overrides?.writeFile ??
      (async (path: string, content: string) => {
        await writeFile(path, content, "utf8");
      }),
    rename: overrides?.rename ?? rename,
    rm:
      overrides?.rm ??
      (async (path: string) => {
        await rm(path, { force: true });
      }),
  };
}

function redactionFailureSentinel(reason: string): string {
  return `${JSON.stringify({
    type: CODEX_EVENTS_REDACTION_FAILED,
    reason,
  })}\n`;
}

function warnCodexEventsCleanupFailed(
  runId: string | undefined,
  path: string,
  e: unknown,
): void {
  const runPart = runId === undefined ? "" : `run ${runId}: `;
  process.stderr.write(
    `warning: ${runPart}could not remove quarantined codex events ` +
      `${basename(path)}: ${(e as Error).message}\n`,
  );
}

async function removeBestEffort(
  io: Required<CodexEventsIo>,
  path: string,
  runId: string | undefined,
): Promise<void> {
  try {
    await io.rm(path);
  } catch (e) {
    warnCodexEventsCleanupFailed(runId, path, e);
  }
}

export async function publishRedactedCodexEvents(opts: {
  rawPath: string;
  tmpPath: string;
  officialPath: string;
  io?: CodexEventsIo | undefined;
  runId?: string | undefined;
  /**
   * Redactor for the raw events. Defaults to the codex redactor; the #191
   * claude backend passes `redactClaudeEvents` (same shape) since the codex
   * redactor's `parsed.item` gate would pass claude events through un-redacted.
   */
  redact?: (content: string) => {
    content: string;
    redactedCount: number;
    droppedCount: number;
  };
}): Promise<PublishCodexEventsResult> {
  const redact = opts.redact ?? redactCodexEvents;
  const io = defaultCodexEventsIo(opts.io);
  const failClosed = async (
    reason: string,
  ): Promise<PublishCodexEventsResult> => {
    await removeBestEffort(io, opts.officialPath, opts.runId);
    try {
      await io.writeFile(opts.officialPath, redactionFailureSentinel(reason));
    } catch {
      // If even the sentinel cannot be written, leave the official path absent.
    }
    await removeBestEffort(io, opts.rawPath, opts.runId);
    await removeBestEffort(io, opts.tmpPath, opts.runId);
    return { redactedCount: 0, droppedCount: 0, failed: true };
  };

  let rawContent: string;
  try {
    rawContent = await io.readFile(opts.rawPath);
  } catch {
    return await failClosed("read_failed");
  }

  const redacted = redact(rawContent);
  try {
    await io.writeFile(opts.tmpPath, redacted.content);
  } catch {
    return await failClosed("write_failed");
  }
  try {
    await io.rename(opts.tmpPath, opts.officialPath);
  } catch {
    return await failClosed("rename_failed");
  }
  await removeBestEffort(io, opts.rawPath, opts.runId);
  return {
    redactedCount: redacted.redactedCount,
    droppedCount: redacted.droppedCount,
    failed: false,
  };
}
