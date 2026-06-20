import type { Command } from "commander";
import { registerDbSchemaCommands } from "./db/schema-commands.js";
import { registerDbMaintenanceCommands } from "./db/maintenance-commands.js";
import { registerDbArchiveCommands } from "./db/archive-commands.js";
import { registerDbDoctorCommands } from "./db/doctor-commands.js";
import { registerDbBlobCommands } from "./db/blob-commands.js";

/**
 * Register the `harness db ...` command group.
 *
 * #125 A15: cli/db.ts を per-concern サブモジュール（src/cli/db/*）へ behaviour-zero
 * 分割した薄い orchestrator。registrar の呼出順 = commander の help 列挙順なので、
 * 順序は golden（cli-help-surface.test.ts）で凍結される（並び替え = P0 違反）。共有
 * helper（getHarnessRoot / dbError / withLock(Async)）は db/shared.ts、blob ヘルパーは
 * db/blob-helpers.ts。
 *
 * Phase 6 added init / migrate / status / import / check-consistency
 * (read model). Phase 7 added export-files (DB-first write path). Phase 8
 * added migrate-artifacts / migrate-legacy and the operational commands
 * backup / restore / checkpoint / vacuum / stats (runtime DB complete).
 */
export function registerDbCommands(program: Command): void {
  const dbCmd = program
    .command("db")
    .description(
      "harness DB — runtime-canonical store + read model (.harness/harness.sqlite)",
    );
  registerDbSchemaCommands(dbCmd);
  registerDbMaintenanceCommands(dbCmd);
  registerDbArchiveCommands(dbCmd);
  registerDbDoctorCommands(dbCmd);
  registerDbBlobCommands(dbCmd);
}
