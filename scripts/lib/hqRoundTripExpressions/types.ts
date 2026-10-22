/**
 * The cutover's shared vocabulary: its step ids in their one order, its
 * blocker and stop codes, what a step returns and what the transform of one
 * app returns (part 09 §3, §5, §11). Every other module of the cutover
 * imports these names and never redefines them.
 *
 * What reaches the report is content-free: step ids, class ids, notice
 * reasons, blocker codes, finding codes and counts. A change's `detail` and a
 * blocker place's `where` and `text` hold authored names, for the notice row
 * and `--debug-details` alone.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { PersistableDoc } from "@/lib/domain";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type {
	DocumentNoticeReason,
	NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import type { RawCarriers } from "./oldShape";

/** The seven steps of part 09 §5, in the one order they run in. */
export const EXPRESSIONS_STEP_IDS = [
	"catalog-rules",
	"form-link-datum-names",
	"record-expressions",
	"form-logic-lift",
	"declare-read-properties",
	"repeat-read-first-row",
	"lift-round-trip",
] as const;
export type ExpressionsStepId = (typeof EXPRESSIONS_STEP_IDS)[number];

/**
 * The classes each step counts on its own (part 09 §5's table). Class `4a`
 * to `4f` of the lift are `respelled`, `relative`, `case-query`,
 * `session-datum`, `choice` and `empty`; `lifted` counts every slot the lift
 * parsed. Step 3's `(a)` and `(b)` are `quotient` and `choice`; `structural`
 * counts every record value it carried over.
 */
export const EXPRESSIONS_CHANGE_CLASSES = {
	"catalog-rules": ["required", "validation", "validation-message"],
	"form-link-datum-names": ["datum-name"],
	"record-expressions": ["structural", "quotient", "choice"],
	"form-logic-lift": [
		"lifted",
		"respelled",
		"relative",
		"case-query",
		"session-datum",
		"choice",
		"empty",
	],
	"declare-read-properties": ["declared", "reparsed"],
	"repeat-read-first-row": ["first-row"],
	"lift-round-trip": [],
} as const satisfies Record<ExpressionsStepId, readonly string[]>;
export type ExpressionsChangeClass<
	S extends ExpressionsStepId = ExpressionsStepId,
> = (typeof EXPRESSIONS_CHANGE_CLASSES)[S][number];

/** One class's tally for one app: how many places the step changed by it. */
export interface StepClassCount {
	readonly step: ExpressionsStepId;
	readonly class: ExpressionsChangeClass;
	readonly count: number;
}

/**
 * The app blockers of part 09 §11, each stopping the cutover before its
 * first write for the remedy its row names.
 */
export const CUTOVER_BLOCKER_CODES = [
	"expression-parse-refused",
	"empty-required-expression",
	"form-link-datum-unresolved",
	"declared-property-type-conflict",
	"declared-property-has-stored-values",
	"old-reference-dangling",
	"target-parse",
	"target-gate",
	"target-export-readiness",
	"case-schema-unplanned",
	"round-trip",
] as const;
export type CutoverBlockerCode = (typeof CUTOVER_BLOCKER_CODES)[number];

/** Stops that are no app's (§11): a live holder, a moved digest, an `unexplained` census verdict. */
export const CUTOVER_STOP_CODES = ["holder", "digest", "unexplained"] as const;
export type CutoverStopCode = (typeof CUTOVER_STOP_CODES)[number];

/**
 * One blocker code of one app, content-free. `findingCodes` holds, sorted
 * and distinct, the parser's issue codes (`expression-parse-refused`), the
 * validator's finding codes (`target-gate`, `target-export-readiness`) or
 * nothing.
 */
export interface CutoverBlocker {
	readonly code: CutoverBlockerCode;
	readonly count: number;
	readonly findingCodes: readonly string[];
	/**
	 * For `target-gate` and `target-export-readiness`: each finding's code
	 * with its `details.reason`, and with `details.checkCode` and
	 * `details.checkReason` where a record slot's type code carries them
	 * (`CODE:reason`, `CODE:checkCode:checkReason`), sorted and distinct, so
	 * the report counts by reason as part 03 §5.4 asks. Content-free.
	 */
	readonly findingReasons?: readonly string[];
}

/**
 * Where one blocker was met, for `--debug-details` on the operator's
 * terminal only, never archived: the owning entity, the slot, the codes and
 * the authored text or message that met it.
 */
export interface BlockerPlace {
	readonly code: CutoverBlockerCode;
	readonly entity?: {
		readonly kind: "app" | "module" | "form" | "field";
		readonly uuid?: string;
	};
	readonly slot?: string;
	readonly findingCode?: string;
	/** Authored: the printed expression or the finding's message. */
	readonly text?: string;
}

/**
 * One line a member of the app is told (part 09 §12). `detail` holds the
 * renderer's keys (`lib/notices/migrationNoticeCopy.ts`), authored names
 * among them; it reaches the notice row and never the report.
 */
export interface DocumentChange {
	readonly reason: DocumentNoticeReason;
	readonly entity: NoticeEntityRef;
	readonly detail?: Readonly<Record<string, string>>;
}

/**
 * A case-store schema change the target derives (§8): a property step 5
 * declared, or one whose type step 3's inference newly knows. `from` is the
 * active stored row's type, or null where the row holds no such property.
 */
export interface PlannedSchemaChange {
	readonly caseType: string;
	readonly property: string;
	readonly from: CasePropertyDataType | null;
	readonly to: CasePropertyDataType;
	readonly source: "declared" | "inferred";
}

/** What a step may read beside the document (§5). */
export interface StepContext {
	readonly appId: string;
	readonly projectId: string;
	/** The Project's rows-free lookup definitions, read once per Project. */
	readonly lookup: LookupDefinitionIndex;
	/**
	 * Per case type, per property key, how many of the app's `cases` rows
	 * hold that key in their properties: step 5's orphan check reads it.
	 */
	readonly storedCaseKeys: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Everything the transform of one app reads, all of it from Nova's database. */
export interface TransformContext {
	readonly appId: string;
	readonly projectId: string;
	/** The Project's lookup definitions, as the gate and export readiness read them. */
	readonly lookupContext: LookupValidationContext;
	/** The Project's media manifest, as export readiness reads it. */
	readonly mediaAssets: ReadonlyMap<string, MediaAssetRecord>;
	/** The app's active `case_type_schemas` rows: case type to schema as stored text. */
	readonly storedCaseSchemas: ReadonlyMap<string, string>;
	/** See `StepContext.storedCaseKeys`. */
	readonly storedCaseKeys: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** What one step returns. */
export interface StepResult {
	readonly changes: readonly DocumentChange[];
	readonly blockers: readonly CutoverBlocker[];
	readonly classes: readonly StepClassCount[];
	readonly places: readonly BlockerPlace[];
}

/** The working state the steps share; defined with the steps (`steps/working.ts`). */
export type { WorkingDocument } from "./steps/working";

/** One step of §5. */
export interface ExpressionsStep {
	readonly id: ExpressionsStepId;
	/** Mutates the transform's private working document only. */
	apply(
		doc: import("./steps/working").WorkingDocument,
		ctx: StepContext,
	): StepResult;
}

/** The transform of one app (§4, §5 and "After the last step"). */
export interface TransformResult {
	/**
	 * The target as `blueprintScalars` and `decomposeBlueprint` write it, or
	 * undefined where it fails the head schema (`target-parse`).
	 */
	readonly target: PersistableDoc | undefined;
	/** Every notice line the steps produce, in step order. */
	readonly changes: readonly DocumentChange[];
	/** One entry per blocker code met, in `CUTOVER_BLOCKER_CODES` order. */
	readonly blockers: readonly CutoverBlocker[];
	readonly schemaChanges: readonly PlannedSchemaChange[];
	/** Every class tally, in step order, zero counts left out. */
	readonly classes: readonly StepClassCount[];
	/** Authored places of each blocker, for `--debug-details` only. */
	readonly places: readonly BlockerPlace[];
}

export type TransformApp = (
	raw: RawCarriers,
	ctx: TransformContext,
) => TransformResult;
