import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  GlobalPolicySchema,
  RepoPolicySchema,
  type GlobalPolicy,
  type RepoPolicy,
} from "./schema.js";

export async function loadGlobalPolicy(path: string): Promise<GlobalPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return GlobalPolicySchema.parse(parsed ?? {});
}

export async function loadRepoPolicy(path: string): Promise<RepoPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return RepoPolicySchema.parse(parsed);
}
