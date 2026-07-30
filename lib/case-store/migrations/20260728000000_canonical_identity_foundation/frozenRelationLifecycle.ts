/**
 * Timestamp-owned relation and catalog-object lifecycle for the canonical
 * identity cutover.
 *
 * The lifecycle has two independent axes:
 *
 * - canonical state: the fold family is wholly absent in `pristine` and wholly
 *   present in `final`;
 * - privilege state: the one logical `cases` carrier is physically
 *   `public.cases` before privilege convergence and
 *   `nova_case_runtime.cases` afterward.
 *
 * Better Auth is external to the case-store ledger. Its seven-table closure is
 * either wholly present, or wholly absent only on a zero-app greenfield
 * database. The production-only orphan repair additionally requires its closed
 * dependency inventory. No partial, duplicate, alternate-schema, or
 * exactly-two-`cases` state is accepted.
 */

export type FrozenRelationLifecycleOwner =
	| "preexisting-case-store"
	| "canonical-created-fold-family"
	| "external-better-auth";

export type FrozenCanonicalRelationPhase = "pristine" | "final";
export type FrozenPrivilegeRelationPhase = "pre-privilege" | "post-privilege";
export type FrozenRelationPurpose = "migration-or-scan" | "repair-production";

export interface FrozenPhysicalRelation {
	readonly schema: string;
	readonly table: string;
}

interface FrozenRelationLifecycleEntry {
	readonly key: string;
	readonly table: string;
	/** Physical name in the exact pre-cutover catalog when it differs. */
	readonly pristineTable?: string;
	readonly owner: FrozenRelationLifecycleOwner;
	readonly occurrence: boolean;
	readonly repairClosure: boolean;
}

/**
 * The logical catalog. `cases` deliberately appears once: its schema is a
 * physical phase projection, not a second carrier.
 */
export const FROZEN_RELATION_LIFECYCLE = [
	{
		key: "apps",
		table: "apps",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "blueprint_entities",
		table: "blueprint_entities",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "app_changes",
		table: "app_changes",
		pristineTable: "accepted_mutations",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "events",
		table: "events",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "threads",
		table: "threads",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "chat_stream_chunks",
		table: "chat_stream_chunks",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "presence",
		table: "presence",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "media_assets",
		table: "media_assets",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: false,
	},
	{
		key: "media_asset_refs",
		table: "media_asset_refs",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "media_upload_aliases",
		table: "media_upload_aliases",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: false,
	},
	{
		key: "lookup_tables",
		table: "lookup_tables",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: false,
	},
	{
		key: "lookup_columns",
		table: "lookup_columns",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: false,
	},
	{
		key: "lookup_rows",
		table: "lookup_rows",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: false,
	},
	{
		key: "lookup_table_references",
		table: "lookup_table_references",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "lookup_column_references",
		table: "lookup_column_references",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "cases",
		table: "cases",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "parked_case_values",
		table: "parked_case_values",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "case_type_schemas",
		table: "case_type_schemas",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "form_submission_intents",
		table: "form_submission_intents",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "form_attachments",
		table: "form_attachments",
		owner: "preexisting-case-store",
		occurrence: true,
		repairClosure: true,
	},
	{
		key: "app_change_fold_baselines",
		table: "app_change_fold_baselines",
		owner: "canonical-created-fold-family",
		occurrence: true,
		repairClosure: false,
	},
	{
		key: "auth_account",
		table: "auth_account",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "auth_apikey",
		table: "auth_apikey",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "auth_invitation",
		table: "auth_invitation",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "auth_member",
		table: "auth_member",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "auth_organization",
		table: "auth_organization",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "auth_session",
		table: "auth_session",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "auth_user",
		table: "auth_user",
		owner: "external-better-auth",
		occurrence: false,
		repairClosure: true,
	},
	{
		key: "run_summaries",
		table: "run_summaries",
		owner: "preexisting-case-store",
		occurrence: false,
		repairClosure: true,
	},
] as const satisfies readonly FrozenRelationLifecycleEntry[];

export type FrozenLogicalRelationKey =
	(typeof FROZEN_RELATION_LIFECYCLE)[number]["key"];

function entriesOwnedBy(owner: FrozenRelationLifecycleOwner) {
	return FROZEN_RELATION_LIFECYCLE.filter((entry) => entry.owner === owner);
}

export const FROZEN_PREEXISTING_RELATION_KEYS = Object.freeze(
	entriesOwnedBy("preexisting-case-store").map((entry) => entry.key),
);

export const FROZEN_CANONICAL_CREATED_RELATION_KEYS = Object.freeze(
	entriesOwnedBy("canonical-created-fold-family").map((entry) => entry.key),
);

export const FROZEN_RELATION_DDL_TRANSITIONS = Object.freeze([
	Object.freeze({
		key: "app_changes",
		pristine: "accepted_mutations",
		final: "app_changes",
		owner: "preexisting-case-store",
	}),
	Object.freeze({
		key: "app_change_fold_baselines",
		pristine: "absent",
		final: "created",
		owner: "canonical-created-fold-family",
	}),
] as const);

export const FROZEN_EXTERNAL_RELATION_KEYS = Object.freeze(
	entriesOwnedBy("external-better-auth").map((entry) => entry.key),
);

export const FROZEN_REPAIR_RELATION_KEYS = Object.freeze(
	FROZEN_RELATION_LIFECYCLE.filter((entry) => entry.repairClosure).map(
		(entry) => entry.key,
	),
);

export const FROZEN_OCCURRENCE_LOGICAL_RELATION_KEYS = Object.freeze(
	FROZEN_RELATION_LIFECYCLE.filter((entry) => entry.occurrence).map(
		(entry) => entry.key,
	),
);

const RELATION_BY_KEY = new Map(
	FROZEN_RELATION_LIFECYCLE.map((entry) => [entry.key, entry] as const),
);
const KNOWN_TABLES = new Set<string>(
	FROZEN_RELATION_LIFECYCLE.flatMap((entry) => [
		entry.table,
		...(!("pristineTable" in entry) || entry.pristineTable === undefined
			? []
			: [entry.pristineTable]),
	]),
);

function relationForKey(
	key: FrozenLogicalRelationKey,
	canonicalPhase: FrozenCanonicalRelationPhase,
	privilegePhase: FrozenPrivilegeRelationPhase,
): FrozenPhysicalRelation {
	const entry = RELATION_BY_KEY.get(key);
	if (entry === undefined) {
		throw new Error(`Unknown frozen logical relation ${key}.`);
	}
	return Object.freeze({
		schema:
			key === "cases" && privilegePhase === "post-privilege"
				? "nova_case_runtime"
				: "public",
		table:
			canonicalPhase === "pristine" &&
			"pristineTable" in entry &&
			entry.pristineTable !== undefined
				? entry.pristineTable
				: entry.table,
	});
}

function physicalKey(relation: FrozenPhysicalRelation): string {
	return `${relation.schema}\u0000${relation.table}`;
}

function displayPhysicalKey(key: string): string {
	return key.replace("\u0000", ".");
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedUniqueRelations(
	relations: readonly FrozenPhysicalRelation[],
): readonly FrozenPhysicalRelation[] {
	const byKey = new Map<string, FrozenPhysicalRelation>();
	for (const relation of relations) {
		byKey.set(physicalKey(relation), Object.freeze({ ...relation }));
	}
	return Object.freeze(
		[...byKey.values()].sort((left, right) =>
			compareUtf8(physicalKey(left), physicalKey(right)),
		),
	);
}

/**
 * Carrier candidates, not a required-relation list. In pristine state the fold
 * carrier is represented by an explicit absent snapshot and is omitted from
 * the lifecycle's required/lockable inventories until `final`.
 */
export function frozenOccurrenceRelationsForPrivilegePhase(
	privilegePhase: FrozenPrivilegeRelationPhase,
): readonly FrozenPhysicalRelation[] {
	return sortedUniqueRelations(
		FROZEN_OCCURRENCE_LOGICAL_RELATION_KEYS.map((key) =>
			relationForKey(key, "final", privilegePhase),
		),
	);
}

export const FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS =
	frozenOccurrenceRelationsForPrivilegePhase("pre-privilege");
export const FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS =
	frozenOccurrenceRelationsForPrivilegePhase("post-privilege");

export const FROZEN_RELATION_CANDIDATE_PHYSICAL_RELATIONS = Object.freeze([
	...sortedUniqueRelations(
		FROZEN_RELATION_LIFECYCLE.flatMap((entry) => {
			if (entry.key === "cases") {
				return [
					{ schema: "public", table: "cases" },
					{ schema: "nova_case_runtime", table: "cases" },
				];
			}
			return [
				{ schema: "public", table: entry.table },
				...(!("pristineTable" in entry) || entry.pristineTable === undefined
					? []
					: [{ schema: "public", table: entry.pristineTable }]),
			];
		}),
	),
]);

export interface FrozenCasesRelationResolution {
	readonly state:
		| "public-pristine"
		| "runtime-post-privilege"
		| "missing"
		| "duplicate";
	readonly relation: FrozenPhysicalRelation | null;
	readonly observed: readonly FrozenPhysicalRelation[];
}

/**
 * Resolve one logical `cases` carrier. A first-present resolver is forbidden
 * because it would silently accept both physical copies.
 */
export function classifyFrozenCasesRelation(
	observedRelations: readonly FrozenPhysicalRelation[],
): FrozenCasesRelationResolution {
	const observedCaseRows = observedRelations.filter(
		(relation) => relation.table === "cases",
	);
	const observed = sortedUniqueRelations(observedCaseRows);
	if (observedCaseRows.length !== observed.length) {
		return Object.freeze({
			state: "duplicate",
			relation: null,
			observed,
		});
	}
	const publicCases = observed.find((relation) => relation.schema === "public");
	const runtimeCases = observed.find(
		(relation) => relation.schema === "nova_case_runtime",
	);
	const alternateCases = observed.filter(
		(relation) =>
			relation.schema !== "public" && relation.schema !== "nova_case_runtime",
	);
	if (
		(publicCases === undefined && runtimeCases === undefined) ||
		alternateCases.length > 0
	) {
		return Object.freeze({
			state: "missing",
			relation: null,
			observed,
		});
	}
	if (publicCases !== undefined && runtimeCases === undefined) {
		return Object.freeze({
			state: "public-pristine",
			relation: publicCases,
			observed,
		});
	}
	if (runtimeCases !== undefined && publicCases === undefined) {
		return Object.freeze({
			state: "runtime-post-privilege",
			relation: runtimeCases,
			observed,
		});
	}
	return Object.freeze({
		state: "duplicate",
		relation: null,
		observed,
	});
}

export function resolveFrozenCasesRelation(
	observedRelations: readonly FrozenPhysicalRelation[],
): FrozenCasesRelationResolution & {
	readonly state: "public-pristine" | "runtime-post-privilege";
	readonly relation: FrozenPhysicalRelation;
} {
	const result = classifyFrozenCasesRelation(observedRelations);
	if (
		(result.state === "public-pristine" ||
			result.state === "runtime-post-privilege") &&
		result.relation !== null
	) {
		return result as FrozenCasesRelationResolution & {
			readonly state: "public-pristine" | "runtime-post-privilege";
			readonly relation: FrozenPhysicalRelation;
		};
	}
	throw new Error(
		`Frozen cases relation must have exactly one physical owner; state=${result.state}.`,
	);
}

export interface FrozenRelationLifecycleContext {
	readonly canonicalPhase: FrozenCanonicalRelationPhase;
	readonly privilegePhase: FrozenPrivilegeRelationPhase;
	readonly purpose: FrozenRelationPurpose;
	/** Exact nonnegative PostgreSQL count text; never a JavaScript number. */
	readonly appCount: string;
}

export interface FrozenRelationInventoryResolution {
	readonly state: "valid" | "drift" | "not-applicable";
	readonly repairState:
		| "not-requested"
		| "applicable"
		| "terminal-not-applicable";
	readonly cases: FrozenCasesRelationResolution;
	readonly authState: "absent-greenfield" | "complete" | "drift";
	readonly requiredRelations: readonly FrozenPhysicalRelation[];
	readonly lockableRelations: readonly FrozenPhysicalRelation[];
	readonly dependencyRelations: readonly FrozenPhysicalRelation[];
	readonly externalRelations: readonly FrozenPhysicalRelation[];
	readonly repairRelations: readonly FrozenPhysicalRelation[];
	readonly missingRelations: readonly string[];
	readonly unexpectedRelations: readonly string[];
	readonly duplicateRelations: readonly string[];
}

/**
 * Classify observed physical relations against one exact lifecycle context.
 *
 * Callers may pass the complete database catalog. Unrelated tables are ignored;
 * a known lifecycle table in an alternate schema is not.
 */
export function classifyFrozenRelationInventory(
	context: FrozenRelationLifecycleContext,
	observedRelations: readonly FrozenPhysicalRelation[],
): FrozenRelationInventoryResolution {
	if (!/^(0|[1-9][0-9]*)$/.test(context.appCount)) {
		throw new Error("Frozen relation app count must be nonnegative.");
	}
	const appCount = BigInt(context.appCount);

	const observedCounts = new Map<string, number>();
	for (const relation of observedRelations) {
		const key = physicalKey(relation);
		observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
	}
	const observedUnique = sortedUniqueRelations(observedRelations);
	const observedKeys = new Set(observedUnique.map(physicalKey));
	const duplicateRelations = [...observedCounts]
		.filter(([, count]) => count !== 1)
		.map(([key]) => displayPhysicalKey(key))
		.sort(compareUtf8);

	const cases = classifyFrozenCasesRelation(observedUnique);
	const expectedCasesState =
		context.privilegePhase === "pre-privilege"
			? "public-pristine"
			: "runtime-post-privilege";

	const observedAuth = observedUnique.filter(
		(relation) =>
			relation.schema === "public" &&
			FROZEN_EXTERNAL_RELATION_KEYS.includes(
				relation.table as (typeof FROZEN_EXTERNAL_RELATION_KEYS)[number],
			),
	);
	const authComplete =
		observedAuth.length === FROZEN_EXTERNAL_RELATION_KEYS.length;
	const authAbsent = observedAuth.length === 0;
	const authState = authComplete
		? "complete"
		: authAbsent &&
				appCount === BigInt(0) &&
				context.privilegePhase === "pre-privilege" &&
				context.purpose !== "repair-production"
			? "absent-greenfield"
			: "drift";

	const requiredKeys = new Set<FrozenLogicalRelationKey>(
		FROZEN_PREEXISTING_RELATION_KEYS,
	);
	if (context.canonicalPhase === "final") {
		for (const key of FROZEN_CANONICAL_CREATED_RELATION_KEYS) {
			requiredKeys.add(key);
		}
	}
	if (authState === "complete") {
		for (const key of FROZEN_EXTERNAL_RELATION_KEYS) requiredKeys.add(key);
	}
	if (context.purpose === "repair-production") {
		for (const key of FROZEN_REPAIR_RELATION_KEYS) requiredKeys.add(key);
	}

	const requiredRelations = sortedUniqueRelations(
		[...requiredKeys].map((key) =>
			relationForKey(key, context.canonicalPhase, context.privilegePhase),
		),
	);
	const requiredPhysicalKeys = new Set(requiredRelations.map(physicalKey));
	const missingRelations = requiredRelations
		.filter((relation) => !observedKeys.has(physicalKey(relation)))
		.map((relation) => displayPhysicalKey(physicalKey(relation)))
		.sort(compareUtf8);

	const unexpectedRelations = observedUnique
		.filter((relation) => {
			if (!KNOWN_TABLES.has(relation.table)) return false;
			const key = physicalKey(relation);
			const entry = FROZEN_RELATION_LIFECYCLE.find(
				(candidate) =>
					candidate.table === relation.table ||
					("pristineTable" in candidate &&
						candidate.pristineTable === relation.table),
			);
			if (entry?.owner === "external-better-auth" && authState === "complete") {
				return relation.schema !== "public";
			}
			if (
				entry?.owner === "external-better-auth" &&
				authState === "absent-greenfield"
			) {
				return true;
			}
			if (
				entry?.owner === "canonical-created-fold-family" &&
				context.canonicalPhase === "pristine"
			) {
				return true;
			}
			return !requiredPhysicalKeys.has(key);
		})
		.map((relation) => displayPhysicalKey(physicalKey(relation)))
		.sort(compareUtf8);

	if (cases.state !== expectedCasesState) {
		for (const relation of cases.observed) {
			const key = displayPhysicalKey(physicalKey(relation));
			if (!unexpectedRelations.includes(key)) unexpectedRelations.push(key);
		}
		if (cases.observed.length === 0) {
			const expected = relationForKey(
				"cases",
				context.canonicalPhase,
				context.privilegePhase,
			);
			const key = displayPhysicalKey(physicalKey(expected));
			if (!missingRelations.includes(key)) missingRelations.push(key);
		}
	}

	if (authState === "drift") {
		for (const key of FROZEN_EXTERNAL_RELATION_KEYS) {
			const relation = relationForKey(
				key,
				context.canonicalPhase,
				context.privilegePhase,
			);
			const physical = physicalKey(relation);
			if (!observedKeys.has(physical)) {
				const display = displayPhysicalKey(physical);
				if (!missingRelations.includes(display)) {
					missingRelations.push(display);
				}
			}
		}
	}

	missingRelations.sort(compareUtf8);
	unexpectedRelations.sort(compareUtf8);
	const lockableRelations = sortedUniqueRelations(
		requiredRelations.filter((relation) =>
			observedKeys.has(physicalKey(relation)),
		),
	);
	const externalRelations = sortedUniqueRelations(
		FROZEN_EXTERNAL_RELATION_KEYS.map((key) =>
			relationForKey(key, context.canonicalPhase, context.privilegePhase),
		).filter((relation) => observedKeys.has(physicalKey(relation))),
	);
	const repairRelations = sortedUniqueRelations(
		FROZEN_REPAIR_RELATION_KEYS.map((key) =>
			relationForKey(
				key as FrozenLogicalRelationKey,
				context.canonicalPhase,
				context.privilegePhase,
			),
		),
	);
	const repairState =
		context.purpose !== "repair-production"
			? "not-requested"
			: context.canonicalPhase === "final"
				? "terminal-not-applicable"
				: "applicable";
	const state =
		repairState === "terminal-not-applicable"
			? "not-applicable"
			: cases.state === expectedCasesState &&
					authState !== "drift" &&
					missingRelations.length === 0 &&
					unexpectedRelations.length === 0 &&
					duplicateRelations.length === 0
				? "valid"
				: "drift";

	return Object.freeze({
		state,
		repairState,
		cases,
		authState,
		requiredRelations,
		lockableRelations,
		dependencyRelations: requiredRelations,
		externalRelations,
		repairRelations,
		missingRelations: Object.freeze(missingRelations),
		unexpectedRelations: Object.freeze(unexpectedRelations),
		duplicateRelations: Object.freeze(duplicateRelations),
	});
}

export function resolveFrozenRelationInventory(
	context: FrozenRelationLifecycleContext,
	observedRelations: readonly FrozenPhysicalRelation[],
): FrozenRelationInventoryResolution & { readonly state: "valid" } {
	const result = classifyFrozenRelationInventory(context, observedRelations);
	if (result.state === "valid") {
		return result as FrozenRelationInventoryResolution & {
			readonly state: "valid";
		};
	}
	if (result.state === "not-applicable") {
		throw new Error(
			"Frozen production repair is terminally not applicable after the canonical fold family exists.",
		);
	}
	const details = [
		result.missingRelations.length > 0
			? `missing=[${result.missingRelations.join(",")}]`
			: null,
		result.unexpectedRelations.length > 0
			? `unexpected=[${result.unexpectedRelations.join(",")}]`
			: null,
		result.duplicateRelations.length > 0
			? `duplicate=[${result.duplicateRelations.join(",")}]`
			: null,
	]
		.filter((detail): detail is string => detail !== null)
		.join(" ");
	throw new Error(`Frozen relation lifecycle drift: ${details}.`);
}

export type FrozenFoldFamilyObjectKind =
	| "relation"
	| "constraint"
	| "trigger"
	| "routine";

export const FROZEN_FOLD_FAMILY_OBJECT_KEYS = [
	"constraint:public:app_change_fold_baselines_change_fkey",
	"constraint:public:app_change_fold_baselines_pkey",
	"constraint:public:app_change_fold_baselines_project_id_nonblank_check",
	"constraint:public:app_change_fold_baselines_snapshot_digest_check",
	"constraint:public:app_changes_app_id_batch_id_key",
	"constraint:public:app_changes_app_id_fkey",
	"constraint:public:app_changes_pkey",
	"constraint:public:app_changes_project_move_scope_check",
	"relation:public:app_change_fold_baselines",
	"relation:public:app_change_fold_baselines_pkey",
	"relation:public:app_changes",
	"relation:public:app_changes_app_id_batch_id_key",
	"relation:public:app_changes_pkey",
	"routine:public:nova_admit_app_change_fold_baseline_insert()",
	"routine:public:nova_admit_app_change_insert()",
	"routine:public:nova_app_change_fold_snapshot_digest(jsonb)",
	"routine:public:nova_current_app_change_fold_snapshot(text)",
	"routine:public:nova_insert_app_change_genesis_fold_baseline(text)",
	"routine:public:nova_reject_app_change_fold_baseline_change()",
	"routine:public:nova_require_app_change_fold_baseline()",
	"routine:public:nova_require_app_change_project_move_final()",
	"routine:public:nova_require_app_project_move_change()",
	"trigger:public:app_change_fold_baselines_admit_insert",
	"trigger:public:app_change_fold_baselines_immutable",
	"trigger:public:app_changes_admit_insert",
	"trigger:public:app_changes_fold_baseline_required",
	"trigger:public:app_changes_project_move_final_required",
	"trigger:public:apps_project_move_app_change_required",
] as const;

export interface FrozenFoldFamilyResolution {
	readonly state: "pristine" | "final" | "drift";
	readonly missingObjects: readonly string[];
	readonly unexpectedObjects: readonly string[];
	readonly duplicateObjects: readonly string[];
}

/**
 * Classify the complete table/index/constraint/trigger/routine family. The
 * caller's catalog query must select every object carrying one of these frozen
 * names across every schema, so a wrong-schema object arrives as unexpected
 * evidence rather than disappearing.
 */
export function classifyFrozenFoldFamily(
	observedObjectKeys: readonly string[],
): FrozenFoldFamilyResolution {
	const expected = new Set<string>(FROZEN_FOLD_FAMILY_OBJECT_KEYS);
	const counts = new Map<string, number>();
	for (const key of observedObjectKeys) {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const actual = new Set(counts.keys());
	const missingObjects = [...expected]
		.filter((key) => !actual.has(key))
		.sort(compareUtf8);
	const unexpectedObjects = [...actual]
		.filter((key) => !expected.has(key))
		.sort(compareUtf8);
	const duplicateObjects = [...counts]
		.filter(([, count]) => count !== 1)
		.map(([key]) => key)
		.sort(compareUtf8);
	const state =
		actual.size === 0 && duplicateObjects.length === 0
			? "pristine"
			: missingObjects.length === 0 &&
					unexpectedObjects.length === 0 &&
					duplicateObjects.length === 0
				? "final"
				: "drift";
	return Object.freeze({
		state,
		missingObjects: Object.freeze(missingObjects),
		unexpectedObjects: Object.freeze(unexpectedObjects),
		duplicateObjects: Object.freeze(duplicateObjects),
	});
}

export interface FrozenCatalogLifecycleResolution {
	readonly state: "valid" | "drift" | "not-applicable";
	readonly relations: FrozenRelationInventoryResolution;
	readonly foldFamily: FrozenFoldFamilyResolution;
}

export interface FrozenObservedCatalogLifecycleResolution {
	readonly state: "pristine" | "final" | "drift" | "repair-not-applicable";
	readonly canonicalPhase: FrozenCanonicalRelationPhase | null;
	readonly privilegePhase: FrozenPrivilegeRelationPhase | null;
	readonly relations: FrozenRelationInventoryResolution;
	readonly foldFamily: FrozenFoldFamilyResolution;
}

/**
 * Derive actual catalog state from physical evidence alone. Scanner and
 * terminal audit use this API so neither can supply the state it intends to
 * prove.
 */
export function classifyFrozenObservedCatalogLifecycle(input: {
	readonly purpose: FrozenRelationPurpose;
	readonly appCount: string;
	readonly observedRelations: readonly FrozenPhysicalRelation[];
	readonly observedFoldObjectKeys: readonly string[];
}): FrozenObservedCatalogLifecycleResolution {
	const cases = classifyFrozenCasesRelation(input.observedRelations);
	const privilegePhase =
		cases.state === "public-pristine"
			? "pre-privilege"
			: cases.state === "runtime-post-privilege"
				? "post-privilege"
				: null;
	const foldFamily = classifyFrozenFoldFamily(input.observedFoldObjectKeys);
	const canonicalPhase =
		foldFamily.state === "pristine"
			? "pristine"
			: foldFamily.state === "final"
				? "final"
				: null;
	const relationPhase: FrozenCanonicalRelationPhase =
		canonicalPhase ??
		(input.observedRelations.some(
			(relation) =>
				relation.schema === "public" &&
				relation.table === "app_change_fold_baselines",
		)
			? "final"
			: "pristine");
	const relations = classifyFrozenRelationInventory(
		{
			canonicalPhase: relationPhase,
			privilegePhase: privilegePhase ?? "pre-privilege",
			purpose: input.purpose,
			appCount: input.appCount,
		},
		input.observedRelations,
	);
	const state =
		relations.state === "not-applicable" && foldFamily.state === "final"
			? "repair-not-applicable"
			: relations.state === "valid" &&
					privilegePhase !== null &&
					foldFamily.state === "pristine"
				? "pristine"
				: relations.state === "valid" &&
						privilegePhase !== null &&
						foldFamily.state === "final"
					? "final"
					: "drift";
	return Object.freeze({
		state,
		canonicalPhase,
		privilegePhase,
		relations,
		foldFamily,
	});
}

/**
 * One state oracle for migration, scanner, and applied-state audit.
 */
export function classifyFrozenCatalogLifecycle(input: {
	readonly context: FrozenRelationLifecycleContext;
	readonly observedRelations: readonly FrozenPhysicalRelation[];
	readonly observedFoldObjectKeys: readonly string[];
}): FrozenCatalogLifecycleResolution {
	const relations = classifyFrozenRelationInventory(
		input.context,
		input.observedRelations,
	);
	const foldFamily = classifyFrozenFoldFamily(input.observedFoldObjectKeys);
	const expectedFoldState =
		input.context.canonicalPhase === "pristine" ? "pristine" : "final";
	return Object.freeze({
		state:
			relations.state === "not-applicable"
				? "not-applicable"
				: relations.state === "valid" && foldFamily.state === expectedFoldState
					? "valid"
					: "drift",
		relations,
		foldFamily,
	});
}

export function resolveFrozenCatalogLifecycle(input: {
	readonly context: FrozenRelationLifecycleContext;
	readonly observedRelations: readonly FrozenPhysicalRelation[];
	readonly observedFoldObjectKeys: readonly string[];
}): FrozenCatalogLifecycleResolution & { readonly state: "valid" } {
	const result = classifyFrozenCatalogLifecycle(input);
	if (result.state === "valid") {
		return result as FrozenCatalogLifecycleResolution & {
			readonly state: "valid";
		};
	}
	if (result.state === "not-applicable") {
		throw new Error(
			"Frozen production repair is terminally not applicable after the canonical fold family exists.",
		);
	}
	throw new Error(
		[
			"Frozen catalog lifecycle drift:",
			`relations=${result.relations.state}`,
			`fold=${result.foldFamily.state}`,
			result.relations.missingRelations.length > 0
				? `missing-relations=[${result.relations.missingRelations.join(",")}]`
				: null,
			result.relations.unexpectedRelations.length > 0
				? `unexpected-relations=[${result.relations.unexpectedRelations.join(",")}]`
				: null,
			result.foldFamily.missingObjects.length > 0
				? `missing-fold=[${result.foldFamily.missingObjects.join(",")}]`
				: null,
			result.foldFamily.unexpectedObjects.length > 0
				? `unexpected-fold=[${result.foldFamily.unexpectedObjects.join(",")}]`
				: null,
		]
			.filter((part): part is string => part !== null)
			.join(" "),
	);
}
