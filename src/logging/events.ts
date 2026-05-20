import { appendFile } from "node:fs/promises";

export type RunEvent = { type: string } & Record<string, unknown>;

export function makeEventWriter(eventsPath: string) {
  return async (event: RunEvent): Promise<void> => {
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  };
}
