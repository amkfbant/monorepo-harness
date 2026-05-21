import { stringify as stringifyYaml } from "yaml";
import { buildContextPack } from "./context-pack-builder.js";
import type { NormalizedContextPack } from "./context-pack-spec.js";

/**
 * Assemble a domain's context packs for a run (Phase 5-7).
 *
 * Resolves each referenced pack against the repo, builds the prompt text
 * (only included, non-secret files) and a `context-pack-manifest.yaml`
 * recording every file — secret-shaped files appear redacted (no content).
 */

/** total byte cap across all of a domain's context packs in one prompt. */
export const MAX_TOTAL_CONTEXT_PACK_BYTES = 64 * 1024;

export interface AssembledContextPacks {
  /** reference block appended to the codex prompt (empty when no content) */
  promptText: string;
  /** YAML for the context-pack-manifest.yaml artifact */
  manifestYaml: string;
  /** the context pack ids that contributed */
  packIds: string[];
}

interface ManifestEntry {
  pack: string;
  path: string;
  bytes: number;
  included: boolean;
  reason?: string;
}

export async function assembleProjectContextPacks(opts: {
  repoPath: string;
  packs: NormalizedContextPack[];
}): Promise<AssembledContextPacks> {
  const manifest: ManifestEntry[] = [];
  const findings: string[] = [];
  const promptParts: string[] = [];
  const packIds: string[] = [];
  let totalBytes = 0;
  let capped = false;

  for (const pack of opts.packs) {
    packIds.push(pack.id);
    const built = await buildContextPack(opts.repoPath, pack);
    for (const f of built.findings) {
      findings.push(`${f.level}: ${f.message}`);
    }
    const fileParts: string[] = [];
    for (const file of built.files) {
      manifest.push({
        pack: pack.id,
        path: file.path,
        bytes: file.bytes,
        included: file.included,
        ...(file.excludedReason !== undefined
          ? { reason: file.excludedReason }
          : {}),
      });
      if (!file.included || file.content === undefined) continue;
      // count the rendered block (header + path + content), not just the
      // raw file size, so the cap bounds the actual injected prompt text.
      const chunk = `### ${file.path}\n\n${file.content.trimEnd()}\n`;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (capped || totalBytes + chunkBytes > MAX_TOTAL_CONTEXT_PACK_BYTES) {
        capped = true;
        continue;
      }
      totalBytes += chunkBytes;
      fileParts.push(chunk);
    }
    if (fileParts.length > 0) {
      promptParts.push(`## context pack: ${pack.id}\n\n${fileParts.join("\n")}`);
    }
  }
  if (capped) {
    findings.push(
      `warn: total context-pack content reached ${MAX_TOTAL_CONTEXT_PACK_BYTES} bytes — later files omitted`,
    );
  }

  return {
    promptText: promptParts.join("\n"),
    manifestYaml: stringifyYaml({
      packs: packIds,
      totalBytes,
      capped,
      findings,
      files: manifest,
    }),
    packIds,
  };
}
