/**
 * The case-writes cutover's shared vocabulary: its marker pair, its step ids
 * in their one order, its blocker and stop codes, its causes, and the
 * content-free shapes every module of the cutover builds and reads (step 5's
 * part 09, sections 6, 7, 8, 10 and 11, the registry these strings are
 * spelled in). Every other module of the cutover imports these names and
 * never redefines them, so the structure phase, the semantic steps, the
 * placement step and the plan agree on one definition of each.
 *
 * What reaches the report or the plan digest is content-free: step ids,
 * change kinds, codes, causes, entity and deployment ids, and counts. Names
 * live only in the notice entries (which reach the notice row and the digest
 * as hashed bytes, never the report) and in a blocker's `places`, which only
 * `--debug-details` prints, on the operator's terminal.
 */

import type { WireIdentityOverride } from "@/lib/commcare/wireIdentity";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { CommCareServer } from "@/lib/deployment/types";
import type { FieldWriteFact } from "@/lib/doc/fieldWriteOperations";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc, MediaAssetId, Uuid } from "@/lib/domain";
import type {
	BasicPlacement,
	SaveToCasePlacement,
} from "@/lib/domain/placements";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";

export type { FieldWriteFact };

// ─── Markers ──────────────────────────────────────────────────────────────

/** The cutover id its notice rows carry. */
export const CUTOVER = "hq-round-trip-case-writes";
/** The batch id of every app's fold-baseline marker row. */
export const MARKER_BATCH_ID = "fold-baseline:hq-round-trip-case-writes";
/** The actor of every app's fold-baseline marker row. */
export const ACTOR_ID = "system:hq-round-trip-case-writes";
/** The text the fleet transaction's advisory lock hashes:
 *  `pg_advisory_xact_lock(hashtextextended(<this>, 0))`. */
export const ADVISORY_LOCK_KEY = "cutover:hq-round-trip-case-writes";
/** The plan's format, part of its digest. */
export const PLAN_FORMAT = "hq-round-trip-case-writes-1";
/** The `report` key of every JSON Lines report line. */
export const REPORT = "hq-round-trip-case-writes";

/** The publish-placement migration (pull request 6, part 03 §4.2). */
export const PUBLISH_PLACEMENT_MIGRATION =
	"20261110000000_hq_round_trip_case_writes_publish_placement";
/** The CommTrack confirmation migration (pull request 8, part 03 §9). */
export const COMMTRACK_CONFIRMATION_MIGRATION =
	"20261110010000_hq_round_trip_case_writes_commtrack_confirmation";
/** The sixth fold identity (pull request 14, part 09 §1). */
export const HORIZON_MIGRATION =
	"20261110020000_hq_round_trip_case_writes_fold_horizon";
/** Exactly the migrations the window's ledger must have pending, in the
 *  order they apply (part 09 §11). */
export const PENDING_MIGRATIONS = [
	PUBLISH_PLACEMENT_MIGRATION,
	COMMTRACK_CONFIRMATION_MIGRATION,
	HORIZON_MIGRATION,
] as const;

// ─── Registries (part 09 §10.2) ───────────────────────────────────────────

/** The structure phase's steps, over raw JSON, in the order they run. */
export const STRUCTURE_STEPS = [
	"renamed-concepts",
	"capture-link-writes",
	"close-condition-expression",
	"field-writes-lifted",
	"search-first-lifted",
] as const;
export type StructureStepId = (typeof STRUCTURE_STEPS)[number];

/** The semantic steps, over the parsed document, in the order they run. */
export const SEMANTIC_STEPS = [
	"writes-into-operations",
	"form-link-semantics",
	"extension-children",
	"explicit-preloads",
	"search-workflow",
	"query-repeat-placement",
	"repeat-counts",
	"field-list-flags",
	"blank-comparisons",
	"placements",
	"judge-target",
	"deployment-lines",
] as const;
export type SemanticStepId = (typeof SEMANTIC_STEPS)[number];

export type CutoverStepId = StructureStepId | SemanticStepId;

/** The app blockers of part 09 §16, each stopping the cutover before its
 *  first write for the remedy its row names. */
export const BLOCKER_CODES = [
	"renamed-concept-conflict",
	"structure-parse",
	"transform-admission",
	"capture-write-unlinkable",
	"own-close-in-repeat",
	"own-close-condition-reads-case",
	"baseline-unreadable",
	"placement-path-mismatch",
	"target-parse",
	"target-gate",
	"target-export-readiness",
	"case-schema-unplanned",
	"not-idempotent",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

/** What stops a run: an app's blocker, or one of the fleet's own stops. */
export const STOP_CODES = [
	"blocker",
	"holder",
	"app-changed",
	"baseline-changed",
	"digest",
	"ledger",
	"partially-applied",
	"lock-timeout",
	"error",
] as const;
export type StopCode = (typeof STOP_CODES)[number];

/** Why a published deployment's case block or answer path moves at its next
 *  publish (part 09 §9), in the order `form-data-paths-move` lists them. */
export const PATH_MOVE_CAUSES = [
	"subcase-renumbered",
	"extension-case-moved",
	"module-made-advanced",
	"repeat-rows-follow-query",
	"count-node-removed",
	"case-changed-before-create",
	"own-close-moved",
	"placement-simplified",
] as const;
export type PathMoveCause = (typeof PATH_MOVE_CAUSES)[number];

/** The planned case-schema differences of part 09 §12. */
export const SCHEMA_CAUSES = [
	"claim-type-row",
	"capture-link-property",
	"derivation-drift",
] as const;
export type SchemaCause = (typeof SCHEMA_CAUSES)[number];

/** The fleet transaction's steps, in the order they run (part 09 §13). */
export const WRITER_STEPS = [
	"lock",
	"blocking-scan",
	"already-applied",
	"before-images",
	"ledger",
	"archive-events",
	"clear-streams",
	"private-work",
	"apps",
	"notices",
	"postconditions",
	"finish",
] as const;
export type WriterStepId = (typeof WRITER_STEPS)[number];

/** The report's sections (part 09 §10.3), in the order a run prints them. */
export const REPORT_SECTIONS = [
	"fleet",
	"structure",
	"steps",
	"placements",
	"path-moves",
	"notice",
	"schema",
	"holders",
	"private-work",
	"blocker",
	"writer",
	"outcome",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** How a run was started: the scan, or one of the migrate script's modes. */
export const RUN_MODES = [
	"scan",
	"dry-run",
	"settle-holders",
	"rehearse",
	"execute",
] as const;
export type RunMode = (typeof RUN_MODES)[number];

// ─── Units and today's placements (part 09 §8.2, §10.1) ──────────────────

/**
 * One unit of a form whose placement the cutover reads and may hold: the
 * own case, the worker's record, a child or extension create per
 * `(case type, nearest repeat)` bucket, a stored case operation, the own
 * close where `main` wrote it apart, and a query repeat. The first four are
 * `lib/domain/caseWriteOperationIdentity.ts::CaseWriteOperationUnit`, so a
 * held placement finds the operation `operationsFromFieldWrites` made for it
 * by the same key.
 */
export type PlacementUnit =
	| "own"
	| "usercase"
	| `child:${string}:${string}`
	| `extension:${string}:${string}`
	| `operation:${string}`
	| "own-close"
	| `query-repeat:${string}`;

/** The key of one unit among every form's: units repeat across forms. */
export function placementUnitKey(formUuid: Uuid, unit: PlacementUnit): string {
	return `${formUuid}|${unit}`;
}

/**
 * Where `main`'s emission put one unit (`frozen/todaysPlacements.ts`), in
 * the head's placement vocabulary: a basic slot, a Save to Case block from
 * its scope, or a query repeat's model iteration.
 */
export interface TodaysPlacement {
	readonly formUuid: Uuid;
	readonly unit: PlacementUnit;
	readonly placement: BasicPlacement | SaveToCasePlacement | "model-iteration";
	/**
	 * The other Save to Case blocks `main` wrote for the unit: an operation's
	 * guard blocks (`nova_guard_<id>_<kind>`), each from the same scope. They
	 * are not the unit's placement, but a baseline carries them, so the frozen
	 * check of section 8.6 reads them as the unit's and never as a block no
	 * unit names.
	 */
	readonly guards: readonly SaveToCasePlacement[];
}

// ─── The lifted facts (part 09 §7) ────────────────────────────────────────

/** What the structure phase lifts out of the raw document for the
 *  semantic steps, before the head parse drops the keys that held it. */
export interface LiftedFacts {
	/** Every field write, per form, in data-tree order. */
	readonly fieldWrites: ReadonlyMap<Uuid, readonly FieldWriteFact[]>;
	/** Capture fields whose stored mode was `attachment` (C5's notice and
	 *  deployment line). */
	readonly attachmentFields: ReadonlySet<Uuid>;
	/** Modules whose stored `caseSearchConfig.searchFirst` was `true`. */
	readonly searchFirst: ReadonlySet<Uuid>;
	/** The frozen preload rule's writers, per form (C7). */
	readonly preloadedWriters: ReadonlyMap<Uuid, readonly Uuid[]>;
	/** Groups whose label the frozen label rule shows (Q4). */
	readonly labelledGroups: ReadonlySet<Uuid>;
	/** Today's placement of every unit, keyed by `placementUnitKey`. */
	readonly todaysPlacements: ReadonlyMap<string, TodaysPlacement>;
	/** Case list media M4 deleted, per module: report only. */
	readonly deadCaseListMedia: ReadonlyMap<
		Uuid,
		readonly ("icon" | "audioLabel")[]
	>;
}

// ─── Published deployments (part 09 §8.1) ────────────────────────────────

/** A deployment that reached `uploaded` and holds a live `app` mapping,
 *  one marked missing on CommCare HQ included. */
export interface PublishedDeployment {
	readonly deploymentId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly baseline:
		| {
				readonly kind: "readable";
				readonly source: unknown;
				readonly sourceDigest: string;
				readonly observedAt: string;
		  }
		/** Origin `create`: an empty app, no form. */
		| { readonly kind: "shell" }
		/** Origin `unread`, or no baseline row: what the project space holds
		 *  was never read, so it is unknown rather than empty. */
		| { readonly kind: "unknown"; readonly why: "unread" | "absent" }
		/** Origin `push` or `cutover` whose bytes fail: the blocker
		 *  `baseline-unreadable`. */
		| {
				readonly kind: "unreadable";
				readonly why: "gunzip" | "digest" | "parse";
		  };
	readonly overrides: readonly WireIdentityOverride[];
	readonly pushedRevision: number | null;
}

/** A baseline's kind as the plan records it. */
export type PlannedBaselineKind =
	| "readable"
	| "shell"
	| "unread"
	| "absent"
	| "unreadable";

// ─── What the steps produce ───────────────────────────────────────────────

/**
 * One change a step plans, content-free: its step, the kind of change the
 * step names it by, the entity it touches (null for the app itself) and its
 * details as counts. Each step module spells its own kinds.
 */
export interface PlannedChange {
	readonly step: CutoverStepId;
	readonly kind: string;
	readonly entityUuid: Uuid | null;
	readonly detail: Readonly<Record<string, number>>;
}

/** Why a held unit is held: a readable baseline carries it, or a published
 *  deployment's baseline is unknown (part 03 §12). */
export type HoldSource = "carried" | "unknown-baseline";

/** One held unit: the `holdPlacements` entry the placement step writes. */
export type HeldUnit = Extract<
	PlacementHoldEntry,
	{ target: "case-operation" | "own-close" | "query-repeat" }
> & {
	readonly unit: PlacementUnit;
	readonly source: HoldSource;
};

/** One published deployment whose next publish moves a case block or an
 *  answer path: how many forms move and why. */
export interface PathMove {
	readonly deploymentId: string;
	readonly forms: number;
	readonly causes: readonly PathMoveCause[];
}

/** A planned case-schema difference the drift writer converges after the
 *  deploy (part 09 §12). */
export interface PlannedSchemaChange {
	readonly caseType: string;
	readonly cause: SchemaCause;
	/** How many properties the difference names; 0 for a missing row. */
	readonly properties: number;
}

/**
 * Where one blocker was met, for `--debug-details` on the operator's
 * terminal only: never in the plan, its digest, the report or the archive.
 */
export interface BlockerPlace {
	readonly entity?: {
		readonly kind: "app" | "module" | "form" | "field";
		readonly uuid: Uuid;
		readonly name?: string;
	};
	readonly findingCode?: string;
	/** Authored: the finding's message. */
	readonly message?: string;
}

/**
 * One blocker code of one app. `findingCodes` holds, sorted and distinct,
 * the codes the blocker met: a validator finding's `CODE` with
 * `CODE:reason` for its `details.reason`, a Zod issue's code with its path
 * of ids and keys, or an admission issue's code. `places` lives in memory
 * only and never enters the plan.
 */
export interface CutoverBlocker {
	readonly code: BlockerCode;
	readonly count: number;
	readonly findingCodes: readonly string[];
	readonly places?: readonly BlockerPlace[];
}

// ─── The transform's context and result (part 09 §7) ─────────────────────

/** What a step may read beside the document, all of it from Nova's database. */
export interface StepContext {
	readonly appId: string;
	readonly projectId: string;
	/** The Project's lookup definitions, read once per Project. */
	readonly lookupContext: LookupValidationContext;
	/** The Project's media records, as export readiness reads them. */
	readonly mediaRecords: ReadonlyMap<MediaAssetId, MediaAssetRecord>;
	/** Section 8.1's deployments; empty for an unpublished app. */
	readonly deployments: readonly PublishedDeployment[];
	/** Active `case_type_schemas` rows, canonical text, by case type. */
	readonly storedSchemas: ReadonlyMap<string, string>;
	/** Every live deployment of the app, published or not, for the
	 *  deployment lines (section 9); empty where the app has none. */
	readonly liveDeployments: readonly LiveDeployment[];
	/** The app's `mutation_seq` at the fleet read, for the frozen check of
	 *  section 8.6. */
	readonly mutationSeq: number;
	/** Whether the writer's `private-work` step discards private work of the
	 *  app (an open workspace, change set or candidate), so its notice ends
	 *  with `unsaved-assistant-work-discarded`. */
	readonly discardsPrivateWork: boolean;
}

/** A live deployment as the notice names it. */
export interface LiveDeployment {
	readonly deploymentId: string;
	readonly server: CommCareServer;
	readonly domain: string;
}

/** What the transform of one app returns. */
export interface AppTransform {
	/** Null where a blocker stopped the transform. */
	readonly target: BlueprintDoc | null;
	readonly changes: readonly PlannedChange[];
	readonly held: readonly HeldUnit[];
	readonly pathMoves: readonly PathMove[];
	/** With names; never printed. */
	readonly notice: readonly MigrationNoticeEntry[];
	readonly blockers: readonly CutoverBlocker[];
	readonly schemaChanges: readonly PlannedSchemaChange[];
	readonly discardsPrivateWork: boolean;
}

// ─── The plan (part 09 §10.2) ─────────────────────────────────────────────

/** One app's part of the plan. */
export interface AppPlan {
	readonly appId: string;
	readonly projectId: string;
	readonly deleted: boolean;
	readonly baseSeq: number;
	/** `oldShape.ts::rawDocumentDigest` of the carriers as read. */
	readonly baseDigest: string;
	/** `canonicalJsonDigest(toPersistableDoc(target))`; null where blocked. */
	readonly targetDigest: string | null;
	readonly deployments: readonly {
		readonly deploymentId: string;
		readonly baseline: PlannedBaselineKind;
		readonly sourceDigest: string | null;
		readonly observedAt: string | null;
	}[];
	readonly changes: readonly PlannedChange[];
	readonly held: readonly HeldUnit[];
	readonly pathMoves: readonly PathMove[];
	readonly notice: readonly MigrationNoticeEntry[];
	/** Without `places`. */
	readonly blockers: readonly CutoverBlocker[];
	readonly schemaChanges: readonly PlannedSchemaChange[];
	readonly discardsPrivateWork: boolean;
}

export interface CaseWritesCutoverPlan {
	readonly format: typeof PLAN_FORMAT;
	/** Every app, deleted ones included, in code-point order of id. */
	readonly apps: readonly AppPlan[];
	/** `lib/utils/canonicalJson.ts::canonicalJsonDigest` of `{ format, apps }`. */
	readonly digest: string;
}

/** Code-point order, so nothing depends on the database's collation. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
