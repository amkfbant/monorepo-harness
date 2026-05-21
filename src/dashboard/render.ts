import type { DashboardSnapshot } from "./snapshot.js";

/**
 * Static dashboard renderer (Phase 6-8).
 *
 * Renders a `DashboardSnapshot` to a self-contained HTML page — no
 * server, no JS, no external assets. The snapshot is the only input, so
 * the page never scans files. `docs/dashboard/index.html` can be opened
 * directly.
 */

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

const STYLE = `
body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}h2{font-size:1.1rem;border-bottom:1px solid #ddd;padding-bottom:.2rem;margin-top:2rem}
h3{font-size:.95rem;margin:1rem 0 .3rem}
.meta{color:#888;font-size:.85rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
td,th{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #eee}
.empty{color:#888;font-style:italic}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.85rem}
.banner{padding:.5rem .75rem;border-radius:4px;font-size:.9rem;margin:.5rem 0}
.banner-ok{background:#eef7ee;border:1px solid #cde3cd}
.banner-warn{background:#fdf4e3;border:1px solid #ecd9a8}
.warn{color:#9a6b00}
`.trim();

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`;
}

function statusBanner(s: DashboardSnapshot): string {
  const filterText =
    s.filters.projectId !== undefined || s.filters.repoId !== undefined
      ? ` · filter: ${esc(s.filters.projectId ?? s.filters.repoId)}`
      : "";
  const cls = s.consistencyStatus === "ok" ? "banner-ok" : "banner-warn";
  const lines = [
    `<div class="banner ${cls}">`,
    `DB: <code>${esc(s.dbPath)}</code> · schema v${s.dbSchemaVersion} · ` +
      `${s.importedRuns} runs imported · consistency: <strong>${esc(s.consistencyStatus)}</strong>`,
    ...s.warnings.map((w) => `<br><span class="warn">⚠ ${esc(w.message)}</span>`),
    "</div>",
    `<p class="meta">generated ${esc(s.generatedAt)} — read-only snapshot${esc(filterText)}</p>`,
  ];
  return lines.join("\n");
}

function overviewSection(s: DashboardSnapshot): string {
  const m = s.overview;
  const rows = Object.keys(m.byStatus)
    .sort()
    .map((k) => `<tr><td>${esc(k)}</td><td>${m.byStatus[k]}</td></tr>`)
    .join("");
  return [
    "<h2>Overview</h2>",
    `<p>total runs: <strong>${m.totalRuns}</strong> · ` +
      `approved: ${m.approved} · needs_review: ${m.needsReview} · ` +
      `failed: ${m.failed} · approved rate: ${pct(m.approvedRate)}</p>`,
    `<table><tr><th>status</th><th>count</th></tr>${rows}</table>`,
  ].join("\n");
}

function projectsSection(s: DashboardSnapshot): string {
  if (s.projects.length === 0) {
    return '<h2>Projects</h2><p class="empty">no projects</p>';
  }
  const rows = s.projects
    .map(
      (p) =>
        `<tr><td>${esc(p.projectId)}</td><td>${esc(p.repoId)}</td>` +
        `<td>${p.domainCount}</td><td>${p.runCount}</td>` +
        `<td>${p.hasGeneratedPolicy ? "yes" : "no"}</td>` +
        `<td>${esc(p.consistency)}</td></tr>`,
    )
    .join("");
  return [
    "<h2>Projects</h2>",
    "<table><tr><th>project</th><th>repo</th><th>domains</th>" +
      "<th>runs</th><th>policy</th><th>consistency</th></tr>" +
      `${rows}</table>`,
  ].join("\n");
}

function runRows(
  runs: DashboardSnapshot["recentRuns"],
): string {
  return runs
    .map(
      (r) =>
        `<tr><td><code>${esc(r.runId)}</code></td>` +
        `<td>${esc(r.projectId ?? "—")}</td><td>${esc(r.domain)}</td>` +
        `<td>${esc(r.status)}</td><td>${esc(r.startedAt ?? "")}</td></tr>`,
    )
    .join("");
}

function inboxSection(s: DashboardSnapshot): string {
  const i = s.inbox;
  const block = (
    title: string,
    runs: DashboardSnapshot["recentRuns"],
  ): string => {
    if (runs.length === 0) {
      return `<h3>${esc(title)}</h3><p class="empty">none</p>`;
    }
    return (
      `<h3>${esc(title)} (${runs.length})</h3>` +
      `<table><tr><th>run</th><th>project</th><th>domain</th>` +
      `<th>status</th><th>started</th></tr>${runRows(runs)}</table>`
    );
  };
  return [
    "<h2>Inbox</h2>",
    block("Needs review", i.needsReview),
    block("Changes requested", i.changesRequested),
    block("Failed", i.failed),
    `<p class="meta">runs with knowledge candidates: ${i.knowledgeCandidateRuns}</p>`,
  ].join("\n");
}

function recentRunsSection(s: DashboardSnapshot): string {
  if (s.recentRuns.length === 0) {
    return '<h2>Recent runs</h2><p class="empty">no runs</p>';
  }
  return [
    "<h2>Recent runs</h2>",
    "<table><tr><th>run</th><th>project</th><th>domain</th>" +
      `<th>status</th><th>started</th></tr>${runRows(s.recentRuns)}</table>`,
  ].join("\n");
}

function backlogSection(s: DashboardSnapshot): string {
  const b = s.backlog;
  if (b.items.length === 0) {
    return '<h2>Backlog</h2><p class="empty">no items</p>';
  }
  const rows = b.items
    .map(
      (it) =>
        `<tr><td><code>${esc(it.itemId)}</code></td>` +
        `<td>${esc(it.status)}</td><td>${esc(it.priority)}</td>` +
        `<td>${esc(it.domain)}</td><td>${esc(it.title)}</td></tr>`,
    )
    .join("");
  return [
    "<h2>Backlog</h2>",
    "<table><tr><th>item</th><th>status</th><th>priority</th>" +
      `<th>domain</th><th>title</th></tr>${rows}</table>`,
  ].join("\n");
}

function knowledgeSection(s: DashboardSnapshot): string {
  const k = s.knowledge;
  const kinds = Object.keys(k.byKind).sort();
  const rows =
    kinds.length === 0
      ? '<tr><td class="empty" colspan="2">no candidates</td></tr>'
      : kinds
          .map((kind) => `<tr><td>${esc(kind)}</td><td>${k.byKind[kind]}</td></tr>`)
          .join("");
  return [
    "<h2>Knowledge</h2>",
    `<p>candidates: ${k.candidateTotal} · promoted entries: ${k.entryTotal}</p>`,
    `<table><tr><th>candidate kind</th><th>count</th></tr>${rows}</table>`,
  ].join("\n");
}

/** Render the whole dashboard page from a snapshot. */
export function renderDashboardHtml(snapshot: DashboardSnapshot): string {
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
    statusBanner(snapshot),
    overviewSection(snapshot),
    projectsSection(snapshot),
    inboxSection(snapshot),
    recentRunsSection(snapshot),
    backlogSection(snapshot),
    knowledgeSection(snapshot),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
