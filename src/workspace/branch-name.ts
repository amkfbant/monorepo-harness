export function runBranchName(runId: string, domain: string): string {
  const slug = domain
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `harness/${runId}/${slug}`;
}
