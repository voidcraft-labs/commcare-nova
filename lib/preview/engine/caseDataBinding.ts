// lib/preview/engine/caseDataBinding.ts
//
// Server Actions for the running-app view's case-data binding.
// Each action resolves the request's session, constructs a
// tenant-scoped `CaseStore` via `withOwnerContext(session.user.id)`
// wrapped in `schemaHealingCaseStore` (every individual store call
// self-heals a missing schema row and retries itself once), and
// delegates to an I/O helper in `./caseDataBindingHelpers.ts`
// (server-only) or an error mapper in `./caseDataBindingClient.ts`
// (client-bundle-safe). Tests bypass the actions and inject a
// `CaseStore` directly. Centralizing session resolution here means
// a change to the auth strategy lands in one file.

"use server";

import { getSession } from "@/lib/auth-utils";
import {
	buildCaseTypeMap,
	CaseTypeNotInBlueprintError,
	withOwnerContext,
} from "@/lib/case-store";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CaseListConfig } from "@/lib/domain";
import { caseListConfigSchema } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import {
	mapCaseListPreviewError,
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
} from "./caseDataBindingClient";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	readCaseData,
	readCaseListPreview,
	readCases,
	readFilterPreview,
	resetSampleCases,
	schemaHealingCaseStore,
	seedSampleCases,
} from "./caseDataBindingHelpers";
import type {
	LoadCaseDataResult,
	LoadCaseListPreviewResult,
	LoadCasesResult,
	LoadFilterPreviewResult,
	PopulateSampleCasesResult,
	SubmissionMutation,
	SubmissionResult,
} from "./caseDataBindingTypes";
import type { SearchInputValues } from "./runtimeBindings";

// Errors thrown by the case-store layer are caught and mapped to
// the `{ kind: "error" }` arm so an unhandled throw never tears
// down Next's RSC tree.

/**
 * Strip the in-memory `fieldParent` reverse index a doc-store snapshot
 * carries — `pickBlueprintDoc` re-attaches it on the wire, but the
 * persisted `blueprintDocSchema` is `.strict()` and would reject the
 * undeclared key. A non-object input (a malformed wire payload — `null`,
 * `undefined`, a bare string) passes through untouched so the caller's
 * strict `safeParse` reports it as the typed `invalid-blueprint` arm
 * rather than `toPersistableDoc`'s destructure throwing on it. The
 * action re-attaches `fieldParent` from the original value after a
 * successful parse for `buildCaseTypeMap`'s type.
 */
function stripDerivedFieldParent(blueprint: unknown): unknown {
	return typeof blueprint === "object" && blueprint !== null
		? toPersistableDoc(blueprint as BlueprintDoc)
		: blueprint;
}

/**
 * Load every case row of a case type for the running-app view.
 *
 * The running-app case list renders the module's authored
 * `caseListConfig.columns`, including `kind: "calculated"` columns
 * — `readCases` threads each calc-arm column's expression into the
 * single `caseStore.query` call so calc expressions evaluate at
 * the SQL layer. Sort directives on each column thread through
 * `buildCaseStoreSortKeys` so the running-app rows arrive in the
 * same order CCHQ would render them.
 *
 * The args are optional. Callers without a `caseListConfig`
 * (registration / case-loading-form lookups, ad-hoc row inspection)
 * receive rows with an empty `calculated: {}` map per row —
 * `evaluateColumnValue` reads cleanly because any calc-keyed
 * lookup returns `undefined`.
 *
 * `inputValues` carries the running-app search form's per-input
 * value bag — `composeRuntimeFilter` translates it into the
 * input-driven predicate contribution, which AND-composes with the
 * unified `caseListConfig.filter` slot inside `readCases`. Callers
 * not mounting a search form leave it undefined; the helper then
 * skips the runtime-bindings composition entirely.
 */
export async function loadCasesAction(args: {
	appId: string;
	caseType: string;
	blueprint?: BlueprintDoc;
	caseListConfig?: CaseListConfig;
	inputValues?: SearchInputValues;
}): Promise<LoadCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId: args.appId, userId: session.user.id },
		);
		// Convert `BlueprintDoc → ReadonlyMap<string, CaseType>` at the
		// request edge — `readCases` accepts the case-store's actual
		// schema-resolution dependency directly, so the helper stays
		// decoupled from the full blueprint shape.
		return await readCases(store, {
			appId: args.appId,
			caseType: args.caseType,
			caseTypeSchemas: buildCaseTypeMap(args.blueprint),
			caseListConfig: args.caseListConfig,
			inputValues: args.inputValues,
		});
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load cases.",
		};
	}
}

export async function loadCaseDataAction(
	appId: string,
	caseType: string,
	caseId: string,
): Promise<LoadCaseDataResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId, userId: session.user.id },
		);
		return await readCaseData(store, { appId, caseType, caseId });
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load case.",
		};
	}
}

export async function populateSampleCasesAction(
	appId: string,
	caseType: string,
	blueprint: BlueprintDoc,
): Promise<PopulateSampleCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		// Resolve the `CaseType` definition out of the blueprint at the
		// request edge — the case-store's `generateSampleData` reads
		// property declarations + `parent_type` off the definition, so
		// the helper accepts the narrow value directly. A blueprint
		// missing the requested case type throws
		// `CaseTypeNotInBlueprintError` here; the catch block delegates
		// to `mapPopulateSampleCasesError` which surfaces the typed
		// `missing-case-type` arm.
		const found = blueprint.caseTypes?.find((c) => c.name === caseType);
		if (!found) {
			throw new CaseTypeNotInBlueprintError(appId, caseType);
		}
		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId, userId: session.user.id },
		);
		return await seedSampleCases(store, { appId, caseType: found });
	} catch (err) {
		return mapPopulateSampleCasesError(err);
	}
}

/**
 * Drop every existing case row for `(appId, caseType)` and regenerate
 * a fresh sample population. Structural mirror of
 * `populateSampleCasesAction` — same session resolution, same
 * blueprint-edge `CaseType` lookup, same typed-error mapping through
 * `mapPopulateSampleCasesError`. Delegates to `resetSampleCases`
 * which wraps the case-store's atomic `resetSampleData` (delete +
 * regenerate in one transaction).
 *
 * The success arm carries `inserted: number` (the count of
 * regenerated rows). The deleted count is intentionally absent from
 * the result shape — the user-facing UX names the action "Reset
 * sample data", and exposing the two-step composition would leak
 * the atomic contract the case-store was designed to hide.
 */
export async function resetSampleCasesAction(
	appId: string,
	caseType: string,
	blueprint: BlueprintDoc,
): Promise<PopulateSampleCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const found = blueprint.caseTypes?.find((c) => c.name === caseType);
		if (!found) {
			throw new CaseTypeNotInBlueprintError(appId, caseType);
		}
		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId, userId: session.user.id },
		);
		return await resetSampleCases(store, { appId, caseType: found });
	} catch (err) {
		return mapPopulateSampleCasesError(err);
	}
}

/**
 * Load case-list authoring-surface live-preview rows. Resolves the
 * request's session, constructs a tenant-scoped `CaseStore` via
 * `withOwnerContext(session.user.id)`, and delegates to
 * `readCaseListPreview` which routes through
 * `caseStore.query` so calculated columns evaluate at the SQL layer.
 *
 * The action accepts the full `CaseListConfig` so a host mounting
 * both the Display section and the Filters section gets predicate
 * narrowing for free without a parallel call site. Display-section-
 * only callers pass a config whose `filter` slot is undefined.
 *
 * Trust-boundary parse: the action is the wire boundary. Both
 * `caseListConfig` AND `blueprint` carry arbitrary AST shapes
 * (`caseListConfig` carries 15 ValueExpression arms + 12+ Predicate
 * arms + Term operands + relation paths; `blueprint` carries the
 * full module / form / field / case-type tree the case-store
 * compiler stack reads property data types from). Either shape
 * arriving malformed over the wire would otherwise reach
 * `compileExpression` / `compilePredicate` / `compileTerm` and
 * surface the compiler's invariant message through the catchall
 * `error` arm. Routing both through `safeParse(...)` traps shape
 * failures as typed `invalid-config` / `invalid-blueprint` arms so
 * the client surface dispatches on the structural cause rather
 * than on a wrapped invariant body. Trusted callers (the Display
 * section's own client component) pass the same shapes the editor
 * + doc-store produce, so both parses are no-ops there; defense-
 * in-depth covers programmatic surfaces, fixtures, and the SA
 * tool path.
 *
 * Action ordering: session-first matches every other action in
 * this file (`loadCasesAction`, `loadCaseDataAction`,
 * `populateSampleCasesAction`, `submitFormAction`). The Zod parse
 * runs after session resolution but before the store call —
 * unauthenticated requests short-circuit on the session check;
 * authenticated requests with malformed payloads short-circuit on
 * the parse before the case-store contacts Postgres. Both
 * `getSession` and `safeParse` are cheap, so the auth-first
 * ordering is stylistic consistency rather than a perf decision.
 *
 * Authoring-surface contract: the caller MUST suppress the action
 * while any sub-editor reports `valid: false`. An invalid AST
 * reaching `compileExpression` would throw at the SQL layer; the
 * editor's aggregated validity gate is the primary defense, and
 * the typed-error arms surface only the structural failures the
 * gate cannot catch (missing case type after a stale blueprint
 * snapshot, schema-not-synced after a chat completion in flight,
 * invalid-config / invalid-blueprint from a wire-boundary parse
 * failure).
 */
export async function loadCaseListPreviewAction(args: {
	appId: string;
	caseType: string;
	blueprint: BlueprintDoc;
	caseListConfig: CaseListConfig;
	limit?: number;
}): Promise<LoadCaseListPreviewResult> {
	try {
		// Session resolution first — matches every other action in
		// this file. Unauthenticated requests short-circuit before
		// the parse work runs.
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };

		// Wire-boundary parse. `safeParse` returns a discriminated
		// result; the `success: false` arm surfaces the Zod issue's
		// first message as the user-facing detail.
		//
		// `caseListConfig` first because its parse is structurally
		// independent of the blueprint (no cross-references); a
		// malformed config reports its own arm rather than masking
		// under the blueprint arm.
		const parsedConfig = caseListConfigSchema.safeParse(args.caseListConfig);
		if (!parsedConfig.success) {
			const firstIssue = parsedConfig.error.issues[0];
			const message =
				firstIssue !== undefined
					? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
					: "Case-list configuration is malformed.";
			return { kind: "invalid-config", message };
		}
		// Strip the in-memory `fieldParent` index `pickBlueprintDoc`
		// re-attaches before the strict parse — `blueprintDocSchema` is
		// `.strict()` and would reject the undeclared key. The helper is
		// null-safe so a malformed wire payload still surfaces as the
		// typed `invalid-blueprint` arm; the re-attach below restores
		// `fieldParent` for `buildCaseTypeMap`'s type.
		const parsedBlueprint = blueprintDocSchema.safeParse(
			stripDerivedFieldParent(args.blueprint),
		);
		if (!parsedBlueprint.success) {
			const firstIssue = parsedBlueprint.error.issues[0];
			const message =
				firstIssue !== undefined
					? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
					: "Blueprint is malformed.";
			return { kind: "invalid-blueprint", message };
		}

		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId: args.appId, userId: session.user.id },
		);
		// Resolve the `name → CaseType` map once at the request edge —
		// `readCaseListPreview` accepts the case-store's schema-resolution
		// dependency directly so the helper stays decoupled from the full
		// blueprint shape. `buildCaseTypeMap` reads only `caseTypes`, so
		// the parsed persistable shape is passed verbatim (the stripped
		// `fieldParent` index is not load-bearing here).
		return await readCaseListPreview(store, {
			appId: args.appId,
			caseType: args.caseType,
			limit: args.limit,
			caseListConfig: parsedConfig.data,
			caseTypeSchemas: buildCaseTypeMap(parsedBlueprint.data),
		});
	} catch (err) {
		return mapCaseListPreviewError(err);
	}
}

/**
 * Load Filters-section authoring-surface live-preview rows + the
 * full matching count. Resolves the request's session, constructs
 * a tenant-scoped `CaseStore` via `withOwnerContext(session.user.id)`,
 * and delegates to `readFilterPreview` which routes through
 * `caseStore.query` (row sample) + `caseStore.count`
 * (totality figure) — both compile the same predicate through the
 * same stack so the count + row-list pair is internally consistent.
 *
 * Trust-boundary parse + session-first ordering match
 * `loadCaseListPreviewAction`'s shape verbatim — the action is
 * structurally a sibling of the case-list preview action with a
 * different result shape (rows + totalCount, vs rows alone). Both
 * actions read the same `caseListConfig` shape; the only divergence
 * is which slot of the config they treat as load-bearing
 * (`calculatedColumns` + `sort` for the case-list preview;
 * `filter` for the Filters-section preview).
 *
 * Authoring-surface contract: the caller MUST suppress the action
 * while the filter editor reports `valid: false`. An invalid
 * predicate AST reaching `compilePredicate` would throw at the SQL
 * layer; the editor's validity gate is the primary defense, and
 * the typed-error arms surface only the structural failures the
 * gate cannot catch.
 */
export async function loadFilterPreviewAction(args: {
	appId: string;
	caseType: string;
	blueprint: BlueprintDoc;
	caseListConfig: CaseListConfig;
	limit?: number;
}): Promise<LoadFilterPreviewResult> {
	try {
		// Session-first matches every other action in this file. An
		// unauthenticated request short-circuits before the parse
		// work runs.
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };

		// Wire-boundary parse — same shape as
		// `loadCaseListPreviewAction`. `caseListConfig` first because
		// its parse is structurally independent of the blueprint;
		// blueprint second.
		const parsedConfig = caseListConfigSchema.safeParse(args.caseListConfig);
		if (!parsedConfig.success) {
			const firstIssue = parsedConfig.error.issues[0];
			const message =
				firstIssue !== undefined
					? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
					: "Case-list configuration is malformed.";
			return { kind: "invalid-config", message };
		}
		// Strip the in-memory `fieldParent` index before the strict
		// parse — mirrors `loadCaseListPreviewAction`. The helper is
		// null-safe so a malformed wire payload surfaces as the typed
		// `invalid-blueprint` arm rather than a thrown destructure.
		const parsedBlueprint = blueprintDocSchema.safeParse(
			stripDerivedFieldParent(args.blueprint),
		);
		if (!parsedBlueprint.success) {
			const firstIssue = parsedBlueprint.error.issues[0];
			const message =
				firstIssue !== undefined
					? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
					: "Blueprint is malformed.";
			return { kind: "invalid-blueprint", message };
		}

		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId: args.appId, userId: session.user.id },
		);
		// `buildCaseTypeMap` reads only `caseTypes`, so the parsed
		// persistable shape goes through directly — same as
		// `loadCaseListPreviewAction`.
		return await readFilterPreview(store, {
			appId: args.appId,
			caseType: args.caseType,
			limit: args.limit,
			caseListConfig: parsedConfig.data,
			caseTypeSchemas: buildCaseTypeMap(parsedBlueprint.data),
		});
	} catch (err) {
		return mapFilterPreviewError(err);
	}
}

/**
 * Apply one form submission's case-store mutations. Discriminates
 * on `mutation.kind` and dispatches to the matching helper in
 * `./caseDataBindingHelpers.ts` — registration writes through
 * `caseStore.insertWithChildren` (atomic primary + children);
 * followup / close run a primary `update` followed by per-child
 * `insert`s, and close additionally calls `caseStore.close` last.
 * Survey is a structural no-op.
 *
 * Caller-supplied `appId` is passed through verbatim to the
 * helpers, matching the shape the other three Server Actions in
 * this file use. The bound `CaseStore` enforces tenant scoping at
 * the SQL layer; the action does not re-check `appId` against
 * `mutation.caseId` for followup / close.
 */
export async function submitFormAction(
	mutation: SubmissionMutation,
	appId: string,
): Promise<SubmissionResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		// The schema heal lives INSIDE the store (one heal per individual
		// store call), never around this dispatch: followup/close run a
		// primary update plus per-child inserts in separate transactions,
		// so a dispatch-level retry would re-insert children that already
		// landed. With the heal at the store call, the one write that threw
		// retries and the dispatch resumes from where it stopped.
		const store = schemaHealingCaseStore(
			await withOwnerContext(session.user.id),
			{ appId, userId: session.user.id },
		);
		switch (mutation.kind) {
			case "registration": {
				const { caseId, childCaseIds } = await applyRegistrationMutation(
					store,
					{ mutation, appId },
				);
				return { kind: "registration", caseId, childCaseIds };
			}
			case "followup": {
				const { caseId, childCaseIds } = await applyFollowupMutation(store, {
					mutation,
					appId,
				});
				return { kind: "followup", caseId, childCaseIds };
			}
			case "close": {
				const { caseId, childCaseIds } = await applyCloseMutation(store, {
					mutation,
					appId,
				});
				return { kind: "close", caseId, childCaseIds };
			}
			case "survey":
				return applySurveyMutation();
			default: {
				// Exhaustive switch — a future `SubmissionMutation` arm
				// landing without a case here surfaces as the standard
				// `unhandledKindMessage` shape rather than silently
				// returning `undefined`.
				const _exhaustive: never = mutation;
				throw new Error(
					unhandledKindMessage({
						where: "preview.caseDataBinding.submitFormAction",
						family: "SubmissionMutation",
						received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
						knownKinds: ["registration", "followup", "close", "survey"],
					}),
				);
			}
		}
	} catch (err) {
		return mapSubmitFormError(err);
	}
}
