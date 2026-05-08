// lib/preview/engine/caseDataBinding.ts
//
// Server Actions for the running-app view's case-data binding.
// Each action resolves the request's session, constructs a
// tenant-scoped `CaseStore` via `withOwnerContext(session.user.id)`,
// and delegates to a pure helper in `./caseDataBindingHelpers.ts`.
// Tests bypass the actions and inject a `CaseStore` directly.
// Centralizing session resolution here means a change to the auth
// strategy lands in one file.

"use server";

import { getSession } from "@/lib/auth-utils";
import { withOwnerContext } from "@/lib/case-store";
import type { BlueprintDoc, CaseListConfig } from "@/lib/domain";
import { caseListConfigSchema } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	mapCaseListPreviewError,
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	readCaseData,
	readCaseListPreview,
	readCases,
	readFilterPreview,
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

// Errors thrown by the case-store layer are caught and mapped to
// the `{ kind: "error" }` arm so an unhandled throw never tears
// down Next's RSC tree.

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
 */
export async function loadCasesAction(args: {
	appId: string;
	caseType: string;
	blueprint?: BlueprintDoc;
	caseListConfig?: CaseListConfig;
}): Promise<LoadCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCases(store, args);
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
		const store = await withOwnerContext(session.user.id);
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
		const store = await withOwnerContext(session.user.id);
		return await seedSampleCases(store, { appId, caseType, blueprint });
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
		const parsedBlueprint = blueprintDocSchema.safeParse(args.blueprint);
		if (!parsedBlueprint.success) {
			const firstIssue = parsedBlueprint.error.issues[0];
			const message =
				firstIssue !== undefined
					? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
					: "Blueprint is malformed.";
			return { kind: "invalid-blueprint", message };
		}

		const store = await withOwnerContext(session.user.id);
		// `blueprintDocSchema.parse(...)` strips `fieldParent` (the
		// derived in-memory reverse-index that's not part of the
		// persisted schema). The case-store's compiler stack doesn't
		// read `fieldParent` — only `caseTypes` for property data-
		// type resolution — but the `BlueprintDoc` type requires the
		// slot. Re-attach the original input's `fieldParent` after
		// the parse so the type contract is satisfied; mirrors
		// `pickBlueprintDoc(...)`'s shape. If the input's
		// `fieldParent` is malformed, downstream call sites that DO
		// read it would surface the issue then; today's case-store
		// callers don't, so the parse covers the load-bearing AST.
		const fullBlueprint: BlueprintDoc = {
			...parsedBlueprint.data,
			fieldParent: args.blueprint.fieldParent ?? {},
		};
		return await readCaseListPreview(store, {
			appId: args.appId,
			caseType: args.caseType,
			limit: args.limit,
			caseListConfig: parsedConfig.data,
			blueprint: fullBlueprint,
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
		const parsedBlueprint = blueprintDocSchema.safeParse(args.blueprint);
		if (!parsedBlueprint.success) {
			const firstIssue = parsedBlueprint.error.issues[0];
			const message =
				firstIssue !== undefined
					? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
					: "Blueprint is malformed.";
			return { kind: "invalid-blueprint", message };
		}

		const store = await withOwnerContext(session.user.id);
		// `fieldParent` re-attach mirrors `loadCaseListPreviewAction`'s
		// shape — the persisted schema doesn't declare the slot, but
		// the `BlueprintDoc` type contract requires it. The case-store's
		// compiler stack reads only `caseTypes`; `fieldParent` is a
		// no-op for the predicate compile path but necessary for the
		// type contract.
		const fullBlueprint: BlueprintDoc = {
			...parsedBlueprint.data,
			fieldParent: args.blueprint.fieldParent ?? {},
		};
		return await readFilterPreview(store, {
			appId: args.appId,
			caseType: args.caseType,
			limit: args.limit,
			caseListConfig: parsedConfig.data,
			blueprint: fullBlueprint,
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
		const store = await withOwnerContext(session.user.id);
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
