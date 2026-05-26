import { createInterface } from "node:readline";
import type { HarnessMcpServer, JsonRpcResponse } from "../server.js";

export interface ServeStdioOptions {
  server: HarnessMcpServer;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
}

function writeResponse(
  output: NodeJS.WritableStream,
  response: JsonRpcResponse,
): void {
  output.write(`${JSON.stringify(response)}\n`);
}

export async function serveMcpStdio(opts: ServeStdioOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const err = opts.error ?? process.stderr;
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (e) {
      const message = (e as Error).message;
      err.write(`mcp stdio parse error: ${message}\n`);
      writeResponse(output, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
          data: { message },
        },
      });
      continue;
    }
    const response = await opts.server.handleMessage(parsed);
    if (response !== undefined) writeResponse(output, response);
  }
  opts.server.close();
}
