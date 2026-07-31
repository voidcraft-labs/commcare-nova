export type FrozenPersistableBlueprintValidationResult =
	| {
			readonly ok: true;
			readonly value: unknown;
	  }
	| {
			readonly ok: false;
			readonly stage: "schema" | "canonicality" | "gate" | "internal";
			readonly facet:
				| "app"
				| "case_types"
				| "modules"
				| "forms"
				| "fields"
				| "user_properties"
				| "user_types"
				| "personas"
				| "unknown";
			readonly evidenceDigest: string;
			readonly codes?: readonly string[];
	  };

/**
 * Self-contained, generated snapshot of the final persisted Blueprint schema
 * plus absolute commit gate. The implementation has no live local imports.
 */
export function validateFrozenPersistableBlueprintCandidate(
	value: unknown,
	lookupContext: FrozenLookupValidationContext,
): FrozenPersistableBlueprintValidationResult;

export interface FrozenLookupColumnDefinition {
	readonly id: string;
	readonly wireName: string;
	readonly label: string;
	readonly dataType: "text" | "int" | "decimal" | "date" | "time" | "datetime";
}

export interface FrozenLookupTableDefinition {
	readonly id: string;
	readonly name: string;
	readonly tag: string;
	readonly definitionRevision: string;
	readonly columns: readonly FrozenLookupColumnDefinition[];
}

export interface FrozenLookupValidationContext {
	readonly kind: "available";
	readonly projectId: string;
	readonly projectRevision: string;
	readonly definitions: readonly FrozenLookupTableDefinition[];
}

export interface FrozenCanonicalAppChangeSuffixRow {
	readonly seq: string;
	readonly batch_id: string;
	readonly run_id: string | null;
	readonly actor_id: string;
	readonly kind: string;
	readonly mutationsText: string;
	readonly from_project_id: string | null;
	readonly to_project_id: string | null;
}

export interface FrozenCanonicalAppChangeFoldInput {
	readonly baselineSnapshotText: string;
	readonly baselineSeq: string;
	readonly baselineProjectId: string;
	readonly expectedHeadSeq: string | number;
	readonly expectedFinalProjectId: string;
	readonly suffix: readonly FrozenCanonicalAppChangeSuffixRow[];
	readonly finalLookupContext: FrozenLookupValidationContext;
}

export interface FrozenCanonicalAppChangeFoldResult {
	readonly snapshot: unknown;
	readonly projectId: string;
	readonly headSeq: string;
	readonly batches: number;
	readonly mutations: number;
}

export function replayFrozenCanonicalAppChangeSuffix(
	input: FrozenCanonicalAppChangeFoldInput,
): FrozenCanonicalAppChangeFoldResult;
