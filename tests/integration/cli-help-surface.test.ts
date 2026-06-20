import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CLI 表層の挙動ゼロ変更 golden（behavioral matrix）。
 *
 * 何を守るか: src/cli/run.ts を register*Commands サブモジュールへ段階分割する際
 * （#125 Track A）、commander の help 列挙順 = `.command()` / register* の呼出順
 * そのものなので、register 呼出を元の inline 位置でなく末尾にまとめると **コマンドの
 * 並びが変わり挙動ゼロ違反**になる（最大の地雷 = P0）。本テストはその並び
 * （= registration order・top-level から leaf まで全階層）と、no-args / unknown /
 * index-stub の exit・stderr を原点に凍結し、全抽出 PR の HARD gate にする。
 *
 * 設計判断:
 * - help テキスト全文でなく「コマンド名の順序付きツリー」を pin する。説明文の
 *   wrap/文言は脆く、守りたい不変条件（並び）はコマンド名の順序だから。
 * - **全階層を再帰捕捉**する。group → subcommand の1階層だけだと、nested group
 *   （例 `review proposals`, `knowledge ops`, `hitch attempt`）の内部順序変更を
 *   見逃す。よって leaf まで降りてツリー全体を inline snapshot で凍結する。
 * - **各 `--help` の exit code === 0 を必ず検査**する。leaf が非0終了 + stdout 空でも
 *   `[]`（=子なし）として通る穴を塞ぐ。
 * - 起動は既存 CLI テストと同じ `node --import tsx src/cli/run.ts <args>`。多数の
 *   --help を spawn するため global semaphore で並行数を絞り、長め timeout を置く。
 */

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "src/cli/run.ts");
const MAX_CONCURRENT = 8;

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

let harnessRoot = "";

beforeAll(() => {
  // --help / 早期 error 系は DB を触らないが、決定論のため空の temp root を渡す。
  harnessRoot = mkdtempSync(join(tmpdir(), "harness-helpsurface-"));
});

// 同時 spawn 数を制限する semaphore（tsx 多重起動の thrash 回避）。
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  return withSlot(async () => {
    try {
      const { stdout, stderr } = await execFileAsync(
        "node",
        ["--import", "tsx", CLI, ...args],
        {
          env: { ...process.env, HARNESS_ROOT: harnessRoot },
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: e.code ?? 1,
      };
    }
  });
}

/** commander の "Commands:" セクションから、コマンド名を出現順に抽出する。 */
function parseCommandNames(helpText: string): string[] {
  const lines = helpText.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Commands:");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // コマンド行は列2でコマンド名が始まる（説明の折返しは深くインデントされ非該当）。
    const m = /^ {2}(\S+)/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

interface CmdNode {
  readonly name: string;
  readonly children: readonly CmdNode[];
}

/**
 * `harness <path...> --help` を再帰的に辿り、コマンド名の**順序付き**ツリーを作る。
 * auto 追加の `help` には降りない（無限ループ防止）。順序を保つため Record でなく
 * 配列で返す（object snapshot は key をソートして順序を失うため）。
 */
async function captureCommandTree(
  path: readonly string[],
  depth: number,
  maxDepth: number,
): Promise<CmdNode[]> {
  const r = await runCli([...path, "--help"]);
  if (r.code !== 0) {
    throw new Error(
      `'harness ${[...path, "--help"].join(" ")}' exited ${r.code}: ` +
        `${r.stderr.trim().slice(0, 160)}`,
    );
  }
  const names = parseCommandNames(r.stdout);
  return Promise.all(
    names.map(async (name): Promise<CmdNode> => {
      if (name === "help" || depth >= maxDepth) {
        return { name, children: [] };
      }
      return {
        name,
        children: await captureCommandTree([...path, name], depth + 1, maxDepth),
      };
    }),
  );
}

/** ツリーを深さ毎インデントの行に描画する（順序・ネストを丸ごと snapshot で凍結）。 */
function renderTree(nodes: readonly CmdNode[], indent = 0): string {
  let out = "";
  for (const n of nodes) {
    out += `${"  ".repeat(indent)}${n.name}\n`;
    out += renderTree(n.children, indent + 1);
  }
  return out;
}

describe("CLI help surface golden (#125 behavior-zero gate)", () => {
  it("top-level コマンドの並び(registration order)が原点で凍結されている", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(parseCommandNames(stdout)).toEqual([
      "run",
      "workflow",
      "lock",
      "review",
      "index",
      "pr",
      "inbox",
      "backlog",
      "dashboard",
      "operations",
      "operation",
      "session",
      "metrics",
      "maintenance",
      "cleanup",
      "rerun",
      "knowledge",
      "workspace",
      "project",
      "policy",
      "db",
      "onboard",
      "hitch",
      "course",
      "phase",
      "mcp",
      "verify-guarded",
      "release",
      "codex",
      "help",
    ]);
  }, 60_000);

  it("no-args / unknown / index-stub の exit・stderr が凍結されている", async () => {
    const noArgs = await runCli([]);
    expect(noArgs.code).toBe(1);
    expect(noArgs.stderr).toMatch(
      /'harness run' requires --repo, --repo-id, --domain, --goal/,
    );

    const unknown = await runCli(["no-such-cmd"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/unknown command 'no-such-cmd'/);

    const index = await runCli(["index"]);
    expect(index.code).toBe(1);
    expect(index.stderr).toMatch(/'harness index' was removed \(Phase 8\)/);
  }, 60_000);

  it("CLI コマンドツリー全階層(group/nested/leaf)が凍結されている", async () => {
    // ルート(harness --help)から leaf まで再帰捕捉。各 --help の code===0 を
    // captureCommandTree 内で検査する（非0終了→throw）。
    const tree = await captureCommandTree([], 0, 6);
    expect(renderTree(tree)).toMatchInlineSnapshot(`
      "run
        show
        timeline
        artifacts
      workflow
        reviewed-run
        help
      lock
        list
        release
        help
      review
        list
        process
        auto
        evaluate
        proposals
          list
          archive
          vacuum
          help
        reviewers
          list
          add
          help
        compare
        help
      index
      pr
        create
        request-review
        help
      inbox
      backlog
        add
        list
        show
        done
        defer
        run
        help
      dashboard
        export
        serve
        help
      operations
        serve
        list
        show
        help
      operation
        confirm
        reject
        help
      session
        plan
        start
        summary
        help
      metrics
        summary
        snapshot
        delta
        domain
        failures
        help
      maintenance
        check
        cleanup
        help
      cleanup
      rerun
        chain
      knowledge
        build-context
        list
        reject
        promote
        deprecate
        import
        export
        show
        edit
        ops
          add
          list
          show
          deprecate
          digest
          export
          import
          help
        digest
        help
      workspace
        create
        verify-pr
        adopt
        list
        inspect
        conflicts
        status
        checkpoint
        recover
        remove
        help
      project
        show
        import
        export
        edit
        inspect
        init
        check
        help
      policy
        snapshot
        compile
        export
        help
      db
        init
        migrate
        import
        export-files
        migrate-artifacts
        migrate-legacy
        check-consistency
        backup
        restore
        checkpoint
        vacuum
        stats
        status
        archive
          list
        attach-archive
        doctor
        repair
        upgrade-check
        blob-store
          add
            local
            help
          list
          help
        migrate-blobs
        verify-blobs
        gc-blobs
        help
      onboard
      hitch
        start
        list
        status
        close
        cancel
        reopen
        recover-diverging
        adopt-pr
        update
        attempt
          start
          complete
          help
        finding
          list
          add
          classify
          fixed
          defer
          help
        review-cycle
          start
          complete
          help
        close-check
          record
          help
        check-convergence
        orchestrate
        await-merge
        help
      course
        create
        list
        show
        status
        orchestrate
        pause
        resume
        close
        export
        help
      phase
        add
        list
        show
        update
        ratify
        link-hitch
        start-hitch
        unlink-hitch
        help
      mcp
        serve
        tools
        resources
        prompts
        config
        sessions
        invocations
        confirmations
        help
      verify-guarded
      release
        plan
        check
        help
      codex
        exec
        help
      help
      "
    `);
  }, 300_000);
});
