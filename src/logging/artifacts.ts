import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeArtifact(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}
