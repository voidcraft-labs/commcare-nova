// lib/preview/engine/caseDataBindingHelpers.ts
//
// Pure I/O helpers the running-app view's data binding wraps in
// Server Actions. Each helper accepts a `CaseStore` parameter so
// tests inject a per-test store directly, while production wraps
// with `withOwnerContext` at the request boundary in
// `./caseDataBinding.ts`. Splitting from the Server Action module
// is required — Next.js's `"use server"` boundary forbids
// non-action exports in the same module.
//
// Helpers return `CaseRow` directly so consumers read the JSONB
// `properties` document the same way `applySchemaChange` and the
// predicate compiler do. The only coercion is `caseRowToFormPreload`
// at the form-engine boundary, which flattens to
// `Map<string, string>` because the engine reasons about input
// strings.

import {
	type CaseInsert,
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CaseRow,
	type CaseStore,
	CaseTypeNotInBlueprintError,
	type CaseUpdate,
	type JsonObject,
	type JsonValue,
	SchemaNotSyncedError,
} from "@/lib/case-store";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { eq, literal, prop } from "@/lib/domain/predicate/builders";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
	SubmissionMutation,
	SubmissionResult,
} from "./caseDataBindingTypes";

/**
 * Default row count for `populateSampleCasesAction`. Spec § sample
 * data pins 30. Exported so tests using `seedSampleCases`
 * directly match production.
 */
export const SAMPLE_CASE_DEFAULT_COUNT = 30;

/**
 * Project a `BlueprintDoc` (or superset like the doc store's
 * `BlueprintDocState`) down to the wire-serializable shape Server
 * Actions accept — every schema field plus `fieldParent`, nothing
 * else. The doc store carries action methods alongside data
 * fields; passing raw state into an action would throw at React's
 * RSC serializer.
 *
 * `blueprintDocSchema.parse(state)` runs Zod's default
 * `.strip()` mode, dropping unknown keys (action methods, any
 * other extras). `fieldParent` re-attaches from the input because
 * it's an in-memory `BlueprintDoc` extension the schema doesn't
 * declare (rebuilt from `fieldOrder` on load, never persisted).
 * Single source of truth: the Zod schema. New `blueprintDocSchema`
 * fields surface in the projection automatically.
 */
export function pickBlueprintDoc<T extends BlueprintDoc>(
	state: T,
): BlueprintDoc {
	return {
		...blueprintDocSchema.parse(state),
		fieldParent: state.fieldParent,
	};
}

/**
 * Read every row of a case type for the bound tenant. `empty`
 * surfaces the "Generate sample data" affordance.
 */
export async function readCases(
	store: CaseStore,
	args: { appId: string; caseType: string },
): Promise<LoadCasesResult> {
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
	});
	if (rows.length === 0) return { kind: "empty" };
	return { kind: "rows", rows };
}

/**
 * UUID 8-4-4-4-12. Matches every Postgres-accepted form (v4 / v7
 * / nil). Authored here rather than imported because the only
 * consumer is `readCaseData`'s caller-id validation.
 */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a single case row by id. `missing` covers absent-id,
 * cross-tenant (equivalent under the case-store contract), AND
 * syntactically invalid UUIDs — the running-app view occasionally
 * inherits a stale link from a deleted case, and surfacing
 * malformed ids as missing keeps the upstream flow structural.
 *
 * No `blueprint` is threaded — `case_id` is a reserved scalar
 * column, so the term compiler never resolves a property
 * `data_type`. `limit: 1` is belt-and-suspenders; the PK
 * guarantees at-most-one match.
 */
export async function readCaseData(
	store: CaseStore,
	args: { appId: string; caseType: string; caseId: string },
): Promise<LoadCaseDataResult> {
	// Postgres rejects malformed UUIDs at the parameter cast (the
	// column is `uuid`-typed). The early-return covers the
	// syntactic-invalid arm before the SQL runs.
	if (!UUID_PATTERN.test(args.caseId)) return { kind: "missing" };
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		predicate: eq(prop(args.caseType, "case_id"), literal(args.caseId)),
		limit: 1,
	});
	const found = rows[0];
	if (found === undefined) return { kind: "missing" };
	return { kind: "row", row: found };
}

/**
 * Populate an empty case type with `SAMPLE_CASE_DEFAULT_COUNT`
 * rows. The seed composes from `Date.now()` so back-to-back
 * populates produce different rows; tests needing reproducibility
 * call `CaseStore.generateSampleData` directly with a fixed seed.
 */
export async function seedSampleCases(
	store: CaseStore,
	args: { appId: string; caseType: string; blueprint: BlueprintDoc },
): Promise<PopulateSampleCasesResult> {
	const result = await store.generateSampleData({
		appId: args.appId,
		caseType: args.caseType,
		count: SAMPLE_CASE_DEFAULT_COUNT,
		seed: `${Date.now()}`,
		blueprint: args.blueprint,
	});
	return { kind: "ok", inserted: result.inserted };
}

/**
 * Map errors from `seedSampleCases` to typed result arms. The
 * three typed errors get dedicated arms so internal vocabulary
 * (e.g. AJV's "Properties payload failed validation for case type
 * ...") doesn't leak through the generic `error` arm into the
 * user-facing path.
 *
 * Lives here (not inline at the Server Action) so the mapping is
 * testable against the case-store contract harness without
 * driving `getSession` / `withOwnerContext`.
 */
export function mapPopulateSampleCasesError(
	err: unknown,
): PopulateSampleCasesResult {
	if (err instanceof CaseTypeNotInBlueprintError) {
		return { kind: "missing-case-type", caseType: err.caseType };
	}
	if (err instanceof SchemaNotSyncedError) {
		return { kind: "schema-not-synced", caseType: err.caseType };
	}
	if (err instanceof CasePropertiesValidationError) {
		return {
			kind: "validation-failure",
			caseType: err.caseType,
			failures: err.failures,
		};
	}
	return {
		kind: "error",
		message: err instanceof Error ? err.message : "Failed to seed cases.",
	};
}

/**
 * Flatten a `CaseRow`'s JSONB document + `case_name` into the
 * `Map<string, string>` shape `useFormEngine` consumes as preload.
 * `case_name` folds into the map under its own key so the form
 * engine sees one source — mirrors the runtime path where the
 * term compiler reads it via `RESERVED_SCALAR_COLUMNS`.
 *
 * `null` values become `""` — the form engine treats missing
 * case-data the same as empty, and JSONB `null` is the same
 * domain state as "no value preloaded".
 */
export function caseRowToFormPreload(row: CaseRow): Map<string, string> {
	const preload = new Map<string, string>();
	preload.set("case_name", row.case_name);
	for (const [key, value] of Object.entries(row.properties)) {
		preload.set(key, jsonValueToString(value));
	}
	return preload;
}

function jsonValueToString(value: JsonValue): string {
	if (value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	// Arrays + objects: round-trippable shape for agent / debug
	// inspection. The form engine has no native handling.
	return JSON.stringify(value);
}

/**
 * Read a column's display value off a `CaseRow`. Resolves
 * reserved scalar columns first, falls through to `row.properties`,
 * `""` for absent. Lives here so every render surface uses the
 * same coercion.
 */
export function caseRowDisplayValue(row: CaseRow, field: string): string {
	if (field === "case_name") return row.case_name;
	if (field === "case_id") return row.case_id;
	if (field === "case_type") return row.case_type;
	if (field === "owner_id") return row.owner_id ?? "";
	if (field === "status") return row.status ?? "";
	const value = row.properties[field];
	if (value === undefined) return "";
	return jsonValueToString(value);
}

// ---------------------------------------------------------------
// Submission-mutation helpers
// ---------------------------------------------------------------
//
// The four `apply*Mutation` helpers consume a `SubmissionMutation`
// arm and dispatch to the `CaseStore`'s matching write method. Each
// helper accepts a `CaseStore` parameter (test-injection pattern,
// same shape as the helpers above). The Server Action in
// `./caseDataBinding.ts` discriminates on `mutation.kind` and routes
// to the matching helper; `mapSubmitFormError` translates the
// case-store's typed errors to typed `SubmissionResult` arms.
//
// Atomicity: registration is atomic via
// `caseStore.insertWithChildren` (primary + every child in one
// Postgres transaction). Followup/close run a primary `update`
// followed by per-child `insert`s; close additionally calls
// `caseStore.close` last. The three writes open separate
// transactions — partial success is observable to the running-app
// view, which re-queries after submission per the
// continuous-validation principle.
//
// `case_id` for the primary registration is left to the case-store
// (its `insertWithChildren` either honors a supplied id or fires
// the `DEFAULT uuidv7()` column default). Child case ids likewise
// flow back from each `insert` / `insertWithChildren` call. No
// helper here generates a UUID.

/**
 * Apply a registration `SubmissionMutation` against the bound
 * store. Construct one `CaseInsert` for the primary plus one per
 * child, then route through `caseStore.insertWithChildren` so the
 * primary + every child land in a single Postgres transaction.
 *
 * The case-store generates the primary's `case_id` and threads it
 * as each child's `parent_case_id` — children must not carry an
 * explicit `parent_case_id`. `status: "open"` is set on every row
 * because the column has no default.
 *
 * `caseName === undefined` on the primary or any child trips a
 * `compilerBugMessage`: `cases.case_name` is `text NOT NULL` and
 * the engine's walker plucks the field whose `id === "case_name"`
 * into the `caseName` slot for every contentful bucket; reaching
 * the throw means the form's field tree omits the name leaf, an
 * upstream blueprint authoring contract violation.
 */
export async function applyRegistrationMutation(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "registration" }>;
		appId: string;
	},
): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	const { mutation, appId } = args;
	if (mutation.primary.caseName === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "preview.caseDataBindingHelpers.applyRegistrationMutation",
				invariant: `registration form for case type \`${mutation.primary.caseType}\` produced no \`case_name\` value`,
				detail:
					"Every registration form must declare a leaf field with `id: \"case_name\"` whose value lands the case's display name in `cases.case_name`. Reaching this throw means the engine's walker emitted a registration mutation whose primary bucket carries no name. Hint: confirm the form's field tree includes a `case_name` leaf bound to the module's case type via `case_property_on`.",
			}),
		);
	}

	const childRows: CaseInsert[] = mutation.children.map((child) => {
		if (child.caseName === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.caseDataBindingHelpers.applyRegistrationMutation",
					invariant: `child-case op for case type \`${child.caseType}\` produced no \`case_name\` value`,
					detail:
						'Every case row carries a top-level `case_name`. A form that creates a child case must include a leaf field with `id: "case_name"` bound to the destination case type via `case_property_on`. Reaching this throw means the form\'s field tree omits the name field for that child type.',
				}),
			);
		}
		return {
			case_type: child.caseType,
			case_name: child.caseName,
			status: "open",
			properties: child.properties,
		};
	});

	const result = await store.insertWithChildren({
		appId,
		primary: {
			case_type: mutation.primary.caseType,
			case_name: mutation.primary.caseName,
			status: "open",
			properties: mutation.primary.properties,
		},
		children: childRows,
	});
	return {
		caseId: result.primaryCaseId,
		childCaseIds: result.childCaseIds,
	};
}

/**
 * Apply a followup `SubmissionMutation`: update the bound case's
 * properties (and optionally `case_name`), then insert each child
 * with `parent_case_id` set to the bound case id (already threaded
 * into `child.parentCaseId` at engine derivation time).
 *
 * Empty-patch short-circuit: when the patch carries neither a
 * `caseName` change nor any `properties` write, skip
 * `caseStore.update` entirely. AJV revalidation + a `modified_on`
 * bump for a no-op patch is wasted work.
 *
 * Three transactions land in sequence (one for the primary update,
 * one per child insert). A failure mid-sequence leaves the
 * already-applied writes in place; the running-app view re-queries
 * on resolve, so the user sees whatever landed.
 */
export async function applyFollowupMutation(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "followup" }>;
		appId: string;
	},
): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	const { mutation, appId } = args;
	await applyPrimaryUpdate(store, { mutation, appId });
	const childCaseIds = await insertChildren(store, {
		appId,
		children: mutation.children,
	});
	return { caseId: mutation.caseId, childCaseIds };
}

/**
 * Apply a close `SubmissionMutation`: same primary update + child
 * inserts as the followup arm, plus a final `caseStore.close` to
 * stamp `closed_on`. Close runs last so the closure timestamp
 * lands after every property write. `caseStore.close` is
 * idempotent on row state — re-closing preserves the original
 * timestamp.
 */
export async function applyCloseMutation(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "close" }>;
		appId: string;
	},
): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	const { mutation, appId } = args;
	await applyPrimaryUpdate(store, { mutation, appId });
	const childCaseIds = await insertChildren(store, {
		appId,
		children: mutation.children,
	});
	await store.close({ appId, caseId: mutation.caseId });
	return { caseId: mutation.caseId, childCaseIds };
}

/**
 * Apply a survey `SubmissionMutation`. Surveys own no case rows;
 * structural no-op. Synchronous because there is no I/O.
 */
export function applySurveyMutation(): Extract<
	SubmissionResult,
	{ kind: "survey" }
> {
	return { kind: "survey" };
}

/**
 * Shared implementation for followup/close primary update so both
 * arms have the same empty-patch skip semantics.
 */
async function applyPrimaryUpdate(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "followup" | "close" }>;
		appId: string;
	},
): Promise<void> {
	const { mutation, appId } = args;
	const hasPropertyWrites = Object.keys(mutation.patch.properties).length > 0;
	const hasCaseNameWrite = mutation.patch.caseName !== undefined;
	if (!hasPropertyWrites && !hasCaseNameWrite) {
		return;
	}
	const patch: CaseUpdate = {
		...(hasPropertyWrites ? { properties: mutation.patch.properties } : {}),
		...(hasCaseNameWrite ? { case_name: mutation.patch.caseName } : {}),
	};
	await store.update({ appId, caseId: mutation.caseId, patch });
}

/**
 * Insert each child of a followup / close mutation in encounter
 * order. The child's `parentCaseId` (bound at engine derivation
 * time to the followup/close `caseId`) lands as the row's
 * `parent_case_id`. Returns generated ids in input order.
 *
 * `caseName === undefined` trips a `compilerBugMessage` for the
 * same reason as the registration arm — every case row carries a
 * top-level `case_name`.
 */
async function insertChildren(
	store: CaseStore,
	args: {
		appId: string;
		children: ReadonlyArray<{
			caseType: string;
			caseName?: string;
			properties: JsonObject;
			parentCaseId: string;
		}>;
	},
): Promise<ReadonlyArray<string>> {
	const ids: string[] = [];
	for (const child of args.children) {
		if (child.caseName === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.caseDataBindingHelpers.insertChildren",
					invariant: `child-case op for case type \`${child.caseType}\` produced no \`case_name\` value`,
					detail:
						'Every case row carries a top-level `case_name`. A form that creates a child case must include a leaf field with `id: "case_name"` bound to the destination case type via `case_property_on`. Reaching this throw means the form\'s field tree omits the name field for that child type.',
				}),
			);
		}
		const row: CaseInsert = {
			case_type: child.caseType,
			case_name: child.caseName,
			status: "open",
			parent_case_id: child.parentCaseId,
			properties: child.properties,
		};
		const { caseId } = await store.insert({ appId: args.appId, row });
		ids.push(caseId);
	}
	return ids;
}

/**
 * Map the case-store's typed errors to typed `SubmissionResult`
 * arms. Mirrors `mapPopulateSampleCasesError` — the four user-
 * domain error classes each get a dedicated discriminator so the
 * running-app view's error toast surfaces structured detail rather
 * than the wrapped invariant body. A generic `Error` falls through
 * to the `error` arm; non-Error throws (rare but possible from RSC
 * framework code) collapse to a default message.
 */
export function mapSubmitFormError(err: unknown): SubmissionResult {
	if (err instanceof CaseNotFoundError) {
		return { kind: "case-not-found", caseId: err.caseId };
	}
	if (err instanceof CasePropertiesValidationError) {
		return {
			kind: "case-properties-validation",
			caseType: err.caseType,
			failures: err.failures,
		};
	}
	if (err instanceof CaseTypeNotInBlueprintError) {
		return { kind: "missing-case-type", caseType: err.caseType };
	}
	if (err instanceof SchemaNotSyncedError) {
		return { kind: "schema-not-synced", caseType: err.caseType };
	}
	return {
		kind: "error",
		message: err instanceof Error ? err.message : "Failed to submit form.",
	};
}
