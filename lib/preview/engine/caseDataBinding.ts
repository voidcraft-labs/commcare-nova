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
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	mapCaseListPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	readCaseData,
	readCaseListPreview,
	readCases,
	seedSampleCases,
} from "./caseDataBindingHelpers";
import type {
	LoadCaseDataResult,
	LoadCaseListPreviewResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
	SubmissionMutation,
	SubmissionResult,
} from "./caseDataBindingTypes";

// Errors thrown by the case-store layer are caught and mapped to
// the `{ kind: "error" }` arm so an unhandled throw never tears
// down Next's RSC tree.

export async function loadCasesAction(
	appId: string,
	caseType: string,
): Promise<LoadCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCases(store, { appId, caseType });
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
 * `caseStore.queryWithCalculated` so calculated columns evaluate at
 * the SQL layer.
 *
 * The action accepts the full `CaseListConfig` so a host mounting
 * both the Display section and the Filters section gets predicate
 * narrowing for free without a parallel call site. Display-section-
 * only callers pass a config whose `filter` slot is undefined.
 *
 * Authoring-surface contract: the caller MUST suppress the action
 * while any sub-editor reports `valid: false`. An invalid AST
 * reaching `compileExpression` would throw at the SQL layer; the
 * editor's aggregated validity gate is the primary defense, and
 * the typed-error arms surface only the structural failures the
 * gate cannot catch (missing case type after a stale blueprint
 * snapshot, schema-not-synced after a chat completion in flight).
 */
export async function loadCaseListPreviewAction(args: {
	appId: string;
	caseType: string;
	blueprint: BlueprintDoc;
	caseListConfig: CaseListConfig;
	limit?: number;
}): Promise<LoadCaseListPreviewResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCaseListPreview(store, args);
	} catch (err) {
		return mapCaseListPreviewError(err);
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
