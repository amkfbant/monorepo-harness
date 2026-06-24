import process from "node:process";
import type { Command } from "commander";
import { CourseRepository } from "../../roadmap/course-repository.js";
import { HitchRepository } from "../../hitch/repository.js";
import { parseHitchCloseConditions, parseHitchPolicy, parseHitchScope } from "../../hitch/schemas.js";
import { PhaseRepository, phaseSpecApprovalStatus } from "../../roadmap/phase-repository.js";
import { PHASE_STATUSES, type PhaseStatus } from "../../roadmap/types.js";
import { withCourseErrorExit, withCourseDb, withCourseRepo, writeOutput, readStructuredFile, parseChoice, parseNonNegativeInt, parsePositiveInt, type RegisterCourseCommandsOptions } from "./helpers.js";

/**
 * `harness phase` サブコマンド（#125 A15: cli/course.ts から behaviour-zero 分割）。
 * add / list / show / update / ratify / link-hitch / start-hitch / unlink-hitch。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerPhaseSubcommands(
  phaseCmd: Command,
  opts: RegisterCourseCommandsOptions,
): void {
  phaseCmd
    .command("add")
    .description("add a phase to a course")
    .requiredOption("--course <id>", "course id")
    .option("--parent <phase-id>", "parent phase id")
    .requiredOption("--title <text>", "phase title")
    .option("--position <n>", "position (integer)")
    .option("--scope-file <path>", "YAML/JSON scope file")
    .option("--close-file <path>", "YAML/JSON close conditions file")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) =>
          phases.add({
            courseId: String(raw.course),
            ...(raw.parent !== undefined ? { parentPhaseId: String(raw.parent) } : {}),
            title: String(raw.title),
            ...(raw.position !== undefined
              ? { position: parseNonNegativeInt(raw.position, "--position") }
              : {}),
            ...(raw.scopeFile !== undefined
              ? { scope: readStructuredFile(String(raw.scopeFile)) }
              : {}),
            ...(raw.closeFile !== undefined
              ? { closeConditions: readStructuredFile(String(raw.closeFile)) }
              : {}),
            createdBy: String(raw.createdBy),
            createdSource: "cli",
          }),
        );
        writeOutput(raw, result, `phase=${result.phaseId} course=${result.courseId} status=${result.status}\n`);
      });
    });

  phaseCmd
    .command("list")
    .description("list phases for a course (tree order)")
    .requiredOption("--course <id>", "course id")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const phases = withCourseRepo(opts, ({ courses, phases: repo }) => {
          const courseId = String(raw.course);
          courses.require(courseId);
          return repo.listForCourse(courseId);
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ phases }, null, 2)}\n`);
        } else {
          process.stdout.write(
            phases
              .map((p) => `${p.phaseId}\t${p.status}\t${p.title}`)
              .join("\n") + (phases.length > 0 ? "\n" : ""),
          );
        }
      });
    });

  phaseCmd
    .command("show")
    .description("show a phase with linked hitch ids")
    .argument("<id>", "phase id")
    .option("--json", "emit JSON", false)
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) => {
          const phase = phases.require(id);
          const hitchIds = phases.hitchIdsFor(id);
          return { phase, hitchIds };
        });
        writeOutput(
          raw,
          result,
          `phase=${result.phase.phaseId} status=${result.phase.status} title=${result.phase.title} hitches=${result.hitchIds.join(",") || "(none)"}\n`,
        );
      });
    });

  phaseCmd
    .command("update")
    .description("update a phase's status, scope/close files, or audit note")
    .argument("<id>", "phase id")
    .option("--status <s>", "new status (pending|in_progress|closed|blocked)")
    .option("--scope-file <path>", "replace scope with YAML/JSON file")
    .option("--close-file <path>", "replace close conditions with YAML/JSON file")
    .option("--allow-scope-widen", "allow a phase scope widening update")
    .option("--allow-gate-loosen", "allow a phase close-gate loosening update")
    .option(
      "--note <text>",
      "operator audit note (e.g. force-close reason / PR ref); shown in course export",
    )
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const newStatus =
          raw.status !== undefined
            ? (parseChoice(raw.status, PHASE_STATUSES, "--status") as PhaseStatus)
            : undefined;
        withCourseDb(opts, (db) => {
          const updated = new PhaseRepository(db).update({
            phaseId: id,
            ...(raw.scopeFile !== undefined
              ? { scope: readStructuredFile(String(raw.scopeFile)) }
              : {}),
            ...(raw.closeFile !== undefined
              ? { closeConditions: readStructuredFile(String(raw.closeFile)) }
              : {}),
            ...(newStatus !== undefined ? { status: newStatus } : {}),
            ...(raw.note !== undefined ? { note: String(raw.note) } : {}),
            allowScopeWiden: raw.allowScopeWiden === true,
            allowGateLoosen: raw.allowGateLoosen === true,
          });
          process.stdout.write(`phase=${updated.phaseId} status=${updated.status}\n`);
        });
      });
    });

  phaseCmd
    .command("ratify")
    .description("record human approval for the phase spec")
    .argument("<id>", "phase id")
    .requiredOption("--approved-by <actor>", "approving operator")
    .option("--reason <text>", "approval reason")
    .option("--json", "emit JSON", false)
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) => {
          const phase = phases.recordSpecApproval(id, {
            approvedBy: String(raw.approvedBy),
            ...(raw.reason !== undefined ? { reason: String(raw.reason) } : {}),
          });
          return {
            phase,
            specApproval: phaseSpecApprovalStatus(phase),
          };
        });
        writeOutput(
          raw,
          result,
          `phase=${result.phase.phaseId} approvedBy=${result.specApproval.approval?.approvedBy ?? ""} specHash=${result.specApproval.currentSpecHash}\n`,
        );
      });
    });

  phaseCmd
    .command("link-hitch")
    .description("link a hitch to a phase")
    .argument("<phase-id>", "phase id")
    .argument("<hitch-id>", "hitch id")
    .option("--allow-scope-widen", "allow a ratified phase scope widening link")
    .option("--allow-gate-loosen", "allow a ratified phase close-gate loosening link")
    .option("--json", "emit JSON", false)
    .action((phaseId: string, hitchId: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) => {
          return phases.linkHitch(phaseId, hitchId, {
            allowScopeWiden: raw.allowScopeWiden === true,
            allowGateLoosen: raw.allowGateLoosen === true,
          });
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const warning of result.warnings) {
            process.stdout.write(`warning: ${warning}\n`);
          }
          process.stdout.write(`linked hitch=${hitchId} to phase=${phaseId}\n`);
        }
      });
    });

  phaseCmd
    .command("start-hitch")
    .description("create a hitch from a phase and link it")
    .argument("<phase-id>", "phase id")
    .requiredOption("--title <text>", "hitch title")
    .option("--hitch-id <id>", "explicit hitch id")
    .option("--description <text>", "hitch description")
    .option("--domain <domain>", "hitch domain")
    .option("--backlog-item-id <id>", "source backlog item id")
    .option("--scope-file <path>", "YAML/JSON hitch scope override")
    .option("--close-file <path>", "YAML/JSON close conditions override")
    .option("--policy-file <path>", "YAML/JSON policy file")
    .option("--max-iterations <n>", "iteration budget")
    .option("--max-review-cycles <n>", "review cycle budget")
    .option("--max-reruns <n>", "rerun budget")
    .option("--max-total-new-findings <n>", "new finding budget")
    .option("--allow-scope-widen", "allow a ratified phase scope widening start")
    .option("--allow-gate-loosen", "allow a ratified phase close-gate loosening start")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((phaseId: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseDb(opts, (db) => {
          const courses = new CourseRepository(db);
          const phases = new PhaseRepository(db);
          const hitches = new HitchRepository(db);
          const tx = db.transaction(() => {
            const phase = phases.require(phaseId);
            const course = courses.require(phase.courseId);
            const scope =
              raw.scopeFile === undefined
                ? parseHitchScope(phase.scope ?? {})
                : parseHitchScope(readStructuredFile(String(raw.scopeFile)));
            const closeConditions =
              raw.closeFile === undefined
                ? parseHitchCloseConditions(phase.closeConditions ?? [])
                : parseHitchCloseConditions(
                    readStructuredFile(String(raw.closeFile)),
                  );
            const hitch = hitches.createSession({
              ...(raw.hitchId !== undefined ? { hitchId: String(raw.hitchId) } : {}),
              title: String(raw.title),
              ...(raw.description !== undefined
                ? { description: String(raw.description) }
                : {}),
              ...(course.projectId !== null ? { projectId: course.projectId } : {}),
              ...(course.repoId !== null ? { repoId: course.repoId } : {}),
              ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
              ...(raw.backlogItemId !== undefined
                ? { backlogItemId: String(raw.backlogItemId) }
                : {}),
              scope,
              closeConditions,
              ...(raw.policyFile !== undefined
                ? { policy: parseHitchPolicy(readStructuredFile(String(raw.policyFile))) }
                : {}),
              ...(raw.maxIterations !== undefined
                ? { maxIterations: parsePositiveInt(raw.maxIterations, "--max-iterations") }
                : {}),
              ...(raw.maxReviewCycles !== undefined
                ? {
                    maxReviewCycles: parsePositiveInt(
                      raw.maxReviewCycles,
                      "--max-review-cycles",
                    ),
                  }
                : {}),
              ...(raw.maxReruns !== undefined
                ? { maxReruns: parseNonNegativeInt(raw.maxReruns, "--max-reruns") }
                : {}),
              ...(raw.maxTotalNewFindings !== undefined
                ? {
                    maxTotalNewFindings: parseNonNegativeInt(
                      raw.maxTotalNewFindings,
                      "--max-total-new-findings",
                    ),
                  }
                : {}),
              createdBy: String(raw.createdBy),
              createdSource: "cli",
            });
            const link = phases.linkHitch(phaseId, hitch.hitchId, {
              allowScopeWiden: raw.allowScopeWiden === true,
              allowGateLoosen: raw.allowGateLoosen === true,
            });
            return { phaseId, hitch, link, warnings: link.warnings };
          });
          return tx.immediate();
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const warning of result.warnings) {
            process.stdout.write(`warning: ${warning}\n`);
          }
          process.stdout.write(
            `hitch=${result.hitch.hitchId} phase=${phaseId} linked\n`,
          );
        }
      });
    });

  phaseCmd
    .command("unlink-hitch")
    .description("unlink a hitch from its phase")
    .argument("<hitch-id>", "hitch id")
    .action((hitchId: string) => {
      withCourseErrorExit(() => {
        const removed = withCourseRepo(opts, ({ phases }) =>
          phases.unlinkHitch(hitchId),
        );
        process.stdout.write(
          removed
            ? `unlinked hitch=${hitchId}\n`
            : `no link for hitch=${hitchId}\n`,
        );
      });
    });
}
