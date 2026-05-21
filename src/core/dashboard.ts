import { writeFile, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { buildInbox, type Inbox, type InboxItem } from "./inbox.js";
import { buildMetrics, type MetricsSummary } from "./metrics.js";
import {
  buildKnowledgeDigest,
  type KnowledgeDigest,
} from "./knowledge-digest.js";
import { loadAllRuns } from "./run-source.js";
import type { ReviewListEntry } from "./review-lister.js";

export interface DashboardOpts {
  runsDir: string;
  workspacesDir: string;
  indexDbPath: string;
  knowledgeDir: string;
  now?: Date;
  /**
   * URL prefix (relative to the HTML file's own dir) for run-dir links.
   * `exportDashboard` computes this from the output path; defaults to the
   * standard docs/dashboard/index.html → runs/ layout.
   */
  runHrefPrefix?: string;
}

/** HTML-escape a value before interpolating it into the page. */
function esc(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

/**
 * Build a self-contained, read-only HTML dashboard. No server, no JS —
 * `docs/dashboard/index.html` can be opened directly. Every run links to
 * its run dir (relative path) so the operator can drill into artifacts.
 */
export async function buildDashboardHtml(
  opts: DashboardOpts,
): Promise<string> {
  const now = opts.now ?? new Date();
  const metrics = await buildMetrics({
    runsDir: opts.runsDir,
    workspacesDir: opts.workspacesDir,
    indexDbPath: opts.indexDbPath,
  });
  const inbox = await buildInbox({
    runsDir: opts.runsDir,
    workspacesDir: opts.workspacesDir,
    indexDbPath: opts.indexDbPath,
    knowledgeDir: opts.knowledgeDir,
  });
  const digest = await buildKnowledgeDigest({
    runsDir: opts.runsDir,
    knowledgeDir: opts.knowledgeDir,
  });
  const { result } = await loadAllRuns(opts.runsDir, opts.indexDbPath);
  const recent = [...result.valid]
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, 15);
  const runHrefPrefix = opts.runHrefPrefix ?? "../../runs";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>monorepo-harness dashboard</title>",
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<h1>monorepo-harness dashboard</h1>",
    `<p class="meta">generated ${esc(now.toISOString())} — read-only snapshot</p>`,
    metricsSection(metrics),
    inboxSection(inbox, runHrefPrefix),
    recentRunsSection(recent, runHrefPrefix),
    knowledgeSection(digest),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Write the dashboard to `outPath` (default docs/dashboard/index.html). */
export async function exportDashboard(
  opts: DashboardOpts & { outPath: string },
): Promise<{ outPath: string; bytes: number }> {
  // run-dir links are relative to the HTML file's own directory, so the
  // prefix depends on where --out places the file.
  const runHrefPrefix = relative(dirname(opts.outPath), opts.runsDir)
    .split(/[\\/]/)
    .join("/");
  const html = await buildDashboardHtml({ ...opts, runHrefPrefix });
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, html, "utf8");
  return { outPath: opts.outPath, bytes: Buffer.byteLength(html, "utf8") };
}

const STYLE = `
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}h2{font-size:1.1rem;border-bottom:1px solid #ddd;padding-bottom:.2rem;margin-top:2rem}
.meta{color:#888;font-size:.85rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
td,th{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #eee}
.empty{color:#888;font-style:italic}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.85rem}
`.trim();

/** A link to a run dir, relative to the dashboard HTML file. */
function runLink(prefix: string, runId: string): string {
  // encodeURIComponent makes runId a safe URL path segment, then esc()
  // makes the whole attribute safe HTML.
  const href = `${prefix}/${encodeURIComponent(runId)}/`;
  return `<a href="${esc(href)}">${esc(runId)}</a>`;
}

function metricsSection(m: MetricsSummary): string {
  const rows = Object.keys(m.runs.byStatus)
    .sort()
    .map((s) => `<tr><td>${esc(s)}</td><td>${m.runs.byStatus[s]}</td></tr>`)
    .join("");
  return [
    "<h2>Metrics</h2>",
    `<p>total runs: <strong>${m.runs.total}</strong> · `,
    `approved rate: ${pct(m.review.approvedRate)} · `,
    `rerun convergence: ${pct(m.retry.convergenceRate)} · `,
    `policy violations: ${m.safety.policyViolations} · `,
    `cleanup pending: ${m.maintenance.cleanupPending}</p>`,
    `<table><tr><th>status</th><th>count</th></tr>${rows}</table>`,
  ].join("\n");
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`;
}

function inboxSection(inbox: Inbox, prefix: string): string {
  const block = (title: string, items: InboxItem[]): string => {
    if (items.length === 0) {
      return `<h3>${esc(title)}</h3><p class="empty">none</p>`;
    }
    const rows = items
      .map(
        (it) =>
          `<tr><td>${runLink(prefix, it.runId)}</td><td>${esc(it.domain)}</td><td>${esc(it.detail)}</td></tr>`,
      )
      .join("");
    return `<h3>${esc(title)} (${items.length})</h3><table>${rows}</table>`;
  };
  return [
    "<h2>Inbox</h2>",
    block("Needs review", inbox.needsReview),
    block("Changes requested", inbox.changesRequested),
    block("Failed", inbox.failed),
    block("Cleanup candidates", inbox.cleanupCandidates),
    block("Knowledge", inbox.knowledge),
  ].join("\n");
}

function recentRunsSection(
  recent: ReviewListEntry[],
  prefix: string,
): string {
  if (recent.length === 0) {
    return '<h2>Recent runs</h2><p class="empty">no runs</p>';
  }
  const rows = recent
    .map(
      (r) =>
        `<tr><td>${runLink(prefix, r.runId)}</td><td>${esc(r.domain)}</td>` +
        `<td>${esc(r.status)}</td><td>${esc(r.startedAt ?? "")}</td></tr>`,
    )
    .join("");
  return [
    "<h2>Recent runs</h2>",
    `<table><tr><th>run</th><th>domain</th><th>status</th><th>started</th></tr>${rows}</table>`,
  ].join("\n");
}

function knowledgeSection(d: KnowledgeDigest): string {
  const kinds = Object.keys(d.candidatesByKind).sort();
  const rows =
    kinds.length === 0
      ? '<tr><td class="empty" colspan="2">no candidates</td></tr>'
      : kinds
          .map(
            (k) =>
              `<tr><td>${esc(k)}</td><td>${d.candidatesByKind[k]}</td></tr>`,
          )
          .join("");
  return [
    "<h2>Knowledge</h2>",
    `<p>candidates: ${d.candidateTotal} · promoted: ${d.promoted} · rejected: ${d.rejected}</p>`,
    `<table><tr><th>candidate kind</th><th>count</th></tr>${rows}</table>`,
  ].join("\n");
}
