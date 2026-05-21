import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadDashboardSnapshot,
  type DashboardFilters,
  type DashboardSnapshot,
} from "./snapshot.js";
import { renderDashboardHtml } from "./render.js";

/**
 * Static dashboard export (Phase 6-8) — the Phase 6 UI deliverable.
 *
 * Builds a `DashboardSnapshot` from the DB read model and renders it to a
 * self-contained HTML file. No server, no file scan. The DB is
 * auto-imported from files unless `autoImport` is false.
 */
export function exportDashboard(opts: {
  harnessRoot: string;
  outPath: string;
  filters?: DashboardFilters;
  autoImport?: boolean;
  now?: Date;
}): { outPath: string; bytes: number; snapshot: DashboardSnapshot } {
  const snapshot = loadDashboardSnapshot({
    harnessRoot: opts.harnessRoot,
    ...(opts.filters !== undefined ? { filters: opts.filters } : {}),
    ...(opts.autoImport !== undefined ? { autoImport: opts.autoImport } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const html = renderDashboardHtml(snapshot);
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, html, "utf8");
  return {
    outPath: opts.outPath,
    bytes: Buffer.byteLength(html, "utf8"),
    snapshot,
  };
}
