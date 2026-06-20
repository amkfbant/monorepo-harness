// hitch-tools barrel（#125 A15）。hitch MCP tool factory を per-concern module に分割:
// hitch-tools-read（read tools）/ hitch-tools-mutation（mutation tools・atomic tx seam）/
// 共有 leaf: hitch-tools-types / 内部層: hitch-tools-helpers。公開 tool 面と resolver を
// 再 export し、tool-registry / resource-registry が "./hitch-tools.js" から import 可能に。
export * from "./hitch-tools-read.js";
export * from "./hitch-tools-mutation.js";
export {
  resolveHitchProjectId,
  resolveHitchFindingProjectId,
} from "./hitch-tools-helpers.js";
// Re-export the arg-shape types that hitch-tools.ts exported before the split so
// any consumer importing them via the ./hitch-tools.js barrel keeps working (the
// limit consts were internal, not part of the prior public surface, so they are
// not re-exported here).
export type {
  HitchListArgs,
  HitchIdArgs,
  HitchStartArgs,
  HitchFindingInput,
  HitchRecordFindingsArgs,
  HitchClassifyFindingArgs,
  HitchMarkFindingFixedArgs,
  HitchDeferFindingArgs,
  HitchRecordCloseCheckArgs,
  HitchCheckConvergenceArgs,
  HitchCloseArgs,
  HitchCancelArgs,
  HitchExpandScopeArgs,
} from "./hitch-tools-types.js";
