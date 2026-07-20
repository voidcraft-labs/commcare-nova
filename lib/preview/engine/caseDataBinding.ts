// lib/preview/engine/caseDataBinding.ts
//
// Server Actions for the running-app view's case-data binding.
// Each action resolves the request's session, then constructs a
// Project-scoped `CaseStore` via `gatedCaseStore` — which verifies the
// actor's membership of the app's Project (the IDOR gate over the
// client-supplied `appId`) and wraps a `withProjectContext` store in
// `schemaHealingCaseStore` (every individual store call self-heals a
// missing or stale schema row and retries itself once) — and delegates
// to an I/O helper in `./caseDataBindingHelpers.ts` (server-only) or an
// error mapper in `./caseDataBindingClient.ts` (client-bundle-safe). A
// membership denial surfaces as the IDOR-safe not-found `error` arm.
// Tests bypass the actions and inject a `CaseStore` directly.
// Centralizing session + membership resolution here means a change to
// the auth strategy lands in one file.

"use server";

import { getSession } from "@/lib/auth-utils";
import {
	buildCaseTypeMap,
	CasePropertiesValidationError,
	type JsonValue,
	ParkedValueNotFoundError,
	type TermBindings,
} from "@/lib/case-store";
import { AppAccessError } from "@/lib/db/appAccess";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseType,
	SearchInputDef,
} from "@/lib/domain";
import {
	caseListConfigSchema,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
} from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import type { ValueExpression } from "@/lib/domain/predicate";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import {
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
} from "./caseDataBindingClient";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	gatedCaseStore,
	readCaseData,
	readCases,
	readFilterPreview,
	resetSampleCases,
	seedSampleCases,
} from "./caseDataBindingHelpers";
import { reportUnexpectedActionError } from "./caseDataBindingTelemetry";
import type {
	LoadCaseCountResult,
	LoadCaseDataResult,
	LoadCasesResult,
	LoadFilterPreviewResult,
	LoadParkedValuesResult,
	PopulateSampleCasesResult,
	ReplaceParkedValueResult,
	RestoreParkedValuesResult,
	SetParkedValuesDismissedResult,
	SubmissionMutation,
	SubmissionResult,
} from "./caseDataBindingTypes";
import { SearchInputValuesError } from "./dateRangeInputValidation";
import {
	type SearchInputValues,
	type SearchInputValuesWire,
	searchInputValuesFromWire,
	withSearchInputExpressionValues,
} from "./runtimeBindings";
import {
	evaluatePreviewSearchExpression,
	type PreviewSearchSessionValues,
	parseExcludedOwnerIds,
	previewSearchSessionValues,
} from "./searchExpressionEvaluation";
import {
	searchInputRuntimeGlobalError,
	searchInputSubmissionErrors,
} from "./searchInputValidation";

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
 * Project the authenticated Preview session into the case-store compiler's
 * runtime binding vocabulary. Search-input expressions read the submitted
 * value (or CommCare's blank value for an unanswered known prompt); closed
 * session-context fields read the authenticated worker; absent open-namespace
 * user-data fields deliberately fall back to blank, matching device XPath.
 */
function previewCaseStoreBindings(
	session: PreviewSearchSessionValues,
	searchInputs: readonly SearchInputDef[] = [],
	inputValues: SearchInputValues = new Map(),
	viewerTimeZone?: string,
): TermBindings {
	const boundInputs = new Map(inputValues);
	for (const input of searchInputs) {
		if (!boundInputs.has(input.name)) boundInputs.set(input.name, "");
	}

	const sessionContext = new Map<string, string>();
	for (const [field, value] of Object.entries(session.context)) {
		if (value !== undefined) sessionContext.set(field, value);
	}

	return {
		searchInputs: boundInputs,
		sessionContext,
		sessionUser: new Map(Object.entries(session.user)),
		sessionUserFallback: "",
		...(viewerTimeZone === undefined ? {} : { viewerTimeZone }),
	};
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
 * value bag as a plain object ({@link SearchInputValuesWire}, not a
 * `Map`) — `composeRuntimeFilter` translates it into the input-driven
 * predicate contribution, which AND-composes with the unified
 * `caseListConfig.filter` slot inside `readCases`. Callers not
 * mounting a search form leave it undefined; the helper then skips
 * the runtime-bindings composition entirely.
 *
 * `excludedOwnerIdsExpression` stays authored until this authenticated
 * boundary. Evaluating it here gives `session-context(userid)` the real
 * current worker id, then `readCases` composes the resolved ids into the same
 * Postgres predicate as the always-on filter and submitted prompts.
 *
 * `caseTypes` is the LIVE case-type catalog — the only blueprint slice
 * the SQL compiler reads (property data types for casts, relation
 * paths to other types). The client sends just this catalog, not the
 * whole `BlueprintDoc`: the modules/forms/fields trees are dead weight
 * here, and the bag stays plain JSON (no `Map`, no outsized body) so
 * the Server Action call never takes a wire shape the edge WAF flags.
 * Sending the live catalog rather than reading the persisted one keeps
 * the schemas consistent with the live `caseListConfig` the client
 * sends in the same call — a property rename/retype reaches both
 * together, so a calc/sort/filter never compiles against a stale type.
 * Callers reading raw rows (case-loading-form lookups) leave it
 * undefined; `readCases` only needs it when a predicate/sort/calc
 * references a typed property.
 */
export async function loadCasesAction(args: {
	appId: string;
	caseType: string;
	caseListConfig?: CaseListConfig;
	inputValues?: SearchInputValuesWire;
	excludedOwnerIdsExpression?: ValueExpression;
	caseTypes?: readonly CaseType[];
	/** Bounded Results window. Omitted by raw-row/legacy callers. */
	page?: { offset: number; limit: number };
	/**
	 * The viewer's IANA timezone — drives `format-date` rendering in
	 * calculated columns (device-local parity). Omitted falls back to UTC.
	 */
	viewerTimeZone?: string;
}): Promise<LoadCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const caseTypeSchemas =
			args.caseTypes && args.caseTypes.length > 0
				? new Map(args.caseTypes.map((ct) => [ct.name, ct]))
				: undefined;
		const inputValues = args.inputValues
			? searchInputValuesFromWire(args.inputValues)
			: undefined;
		const searchSession = previewSearchSessionValues(session.user);
		if (args.caseListConfig !== undefined) {
			const globalRuntimeError = searchInputRuntimeGlobalError(
				args.caseListConfig,
				args.caseType,
				inputValues ?? new Map(),
				searchSession,
				{
					caseTypes: [...(args.caseTypes ?? [])],
					knownInputs: args.caseListConfig.searchInputs.map((input) => ({
						name: input.name,
						data_type: SEARCH_INPUT_RUNTIME_VALUE_TYPES[input.type],
					})),
					currentCaseType: args.caseType,
				},
			);
			if (globalRuntimeError !== undefined) {
				return {
					kind: "invalid-search",
					message: globalRuntimeError,
					repair: "settings",
				};
			}
		}
		if (inputValues !== undefined && args.caseListConfig !== undefined) {
			const runtimeErrors = searchInputSubmissionErrors(
				args.caseListConfig,
				args.caseType,
				inputValues,
				searchSession,
				{
					caseTypes: [...(args.caseTypes ?? [])],
					knownInputs: args.caseListConfig.searchInputs.map((input) => ({
						name: input.name,
						data_type: SEARCH_INPUT_RUNTIME_VALUE_TYPES[input.type],
					})),
					currentCaseType: args.caseType,
				},
			);
			const firstError = runtimeErrors.values().next().value;
			if (firstError !== undefined) {
				return {
					kind: "invalid-search",
					message: firstError,
					repair: "inputs",
				};
			}
		}
		const expressionInputValues =
			inputValues === undefined || args.caseListConfig === undefined
				? inputValues
				: withSearchInputExpressionValues(
						args.caseListConfig.searchInputs,
						inputValues,
					);
		const bindings = previewCaseStoreBindings(
			searchSession,
			args.caseListConfig?.searchInputs,
			expressionInputValues,
			args.viewerTimeZone,
		);
		const excludedOwnerIds =
			args.excludedOwnerIdsExpression === undefined
				? undefined
				: parseExcludedOwnerIds(
						evaluatePreviewSearchExpression(
							args.excludedOwnerIdsExpression,
							searchSession,
							expressionInputValues,
							args.caseListConfig?.searchInputs ?? [],
						),
					);
		const authoredExcludedOwnerIds =
			args.excludedOwnerIdsExpression === undefined
				? undefined
				: parseExcludedOwnerIds(
						evaluatePreviewSearchExpression(
							args.excludedOwnerIdsExpression,
							searchSession,
							args.caseListConfig === undefined
								? undefined
								: withSearchInputExpressionValues(
										args.caseListConfig.searchInputs,
										new Map(),
									),
							args.caseListConfig?.searchInputs ?? [],
						),
					);
		const store = await gatedCaseStore(args.appId, session.user.id, "view");
		return await readCases(store, {
			appId: args.appId,
			caseType: args.caseType,
			caseTypeSchemas,
			caseListConfig: args.caseListConfig,
			inputValues,
			bindings,
			excludedOwnerIds,
			authoredExcludedOwnerIds,
			// Omitted is the pre-pagination action shape. Keep it unpaged so an
			// already-open old client (which has no pager) does not silently lose
			// every row after 50 during a rolling deploy. Explicit new-client page
			// bags are still normalized and capped inside `readCases`.
			page: args.page,
		});
	} catch (err) {
		// A Project-membership denial (`gatedCaseStore` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		// Editable date-range drafts are validated in the running form, but the
		// action repeats the gate for stale/tampered callers. This is a repairable
		// input error, not an observability fault.
		if (err instanceof SearchInputValuesError) {
			return {
				kind: "invalid-search",
				message: err.message,
				repair: "inputs",
			};
		}
		reportUnexpectedActionError("loadCases", err, {
			appId: args.appId,
			caseType: args.caseType,
		});
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load cases.",
		};
	}
}

/**
 * Count every row for one case type, with no authored filter applied. The
 * builder's case-data manager uses this as its source of truth so an empty
 * filtered Results screen can never be mistaken for an empty case store.
 */
export async function loadCaseCountAction(args: {
	appId: string;
	caseType: string;
}): Promise<LoadCaseCountResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, session.user.id, "view");
		const count = await store.count({
			appId: args.appId,
			caseType: args.caseType,
		});
		return { kind: "count", count };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("loadCaseCount", err, {
			appId: args.appId,
			caseType: args.caseType,
		});
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to count cases.",
		};
	}
}

/**
 * Load a single case row plus its ancestor chain for a case-loading
 * form or URL-backed Details screen. `ancestorDepth` is the form's reachable-chain depth
 * (`reachableCaseTypes(...).length - 1`) — how many parent hops any
 * `#<type>/<prop>` ref on the form can address. Client-supplied, so
 * `walkAncestors` clamps it server-side.
 *
 * Details may additionally send the live `caseListConfig` and the small
 * `caseTypes` catalog. Those values project calculated display columns for
 * this one identity-loaded row; they never apply the Results filter, sort,
 * or page. Form callers omit both and keep the raw-row path.
 */
export async function loadCaseDataAction(
	appId: string,
	caseType: string,
	caseId: string,
	ancestorDepth: number,
	caseListConfig?: CaseListConfig,
	caseTypes?: readonly CaseType[],
	viewerTimeZone?: string,
): Promise<LoadCaseDataResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(appId, session.user.id, "view");
		const searchSession = previewSearchSessionValues(session.user);
		const expressionInputValues =
			caseListConfig === undefined
				? undefined
				: withSearchInputExpressionValues(
						caseListConfig.searchInputs,
						new Map(),
					);
		return await readCaseData(store, {
			appId,
			caseType,
			caseId,
			ancestorDepth,
			caseListConfig,
			bindings: previewCaseStoreBindings(
				searchSession,
				caseListConfig?.searchInputs,
				expressionInputValues,
				viewerTimeZone,
			),
			caseTypeSchemas:
				caseTypes && caseTypes.length > 0
					? new Map(caseTypes.map((entry) => [entry.name, entry]))
					: undefined,
		});
	} catch (err) {
		// A Project-membership denial (`gatedCaseStore` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("loadCaseData", err, { appId, caseType });
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load case.",
		};
	}
}

export async function populateSampleCasesAction(
	appId: string,
	caseType: CaseType,
): Promise<PopulateSampleCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		// The LIVE `CaseType` definition comes straight from the client —
		// the generator reads only its property declarations + `parent_type`,
		// so the one catalog entry is all this needs (never the whole
		// blueprint). `gatedCaseStore` verifies the actor holds `edit` on the
		// app's Project before binding the store, so a crafted `appId` for
		// another Project is rejected — the client-supplied id is otherwise
		// unchecked — and generated rows land in that shared Project's store.
		const store = await gatedCaseStore(appId, session.user.id, "edit");
		return await seedSampleCases(store, { appId, caseType });
	} catch (err) {
		// A Project-membership denial (`gatedCaseStore` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		// Sample-data generation: a `CasePropertiesValidationError`
		// here means the GENERATOR produced data its own schema
		// rejects (a bug), so it alerts alongside any raw DB error.
		reportUnexpectedActionError(
			"populateSampleCases",
			err,
			{
				appId,
				caseType: caseType.name,
			},
			{ treatValidationAsBug: true },
		);
		return mapPopulateSampleCasesError(err);
	}
}

/**
 * Drop every existing case row for `(appId, caseType)` and regenerate
 * a fresh sample population. Structural mirror of
 * `populateSampleCasesAction` — same session resolution, same LIVE
 * client-supplied `CaseType`, same typed-error mapping through
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
	caseType: CaseType,
): Promise<PopulateSampleCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(appId, session.user.id, "edit");
		return await resetSampleCases(store, { appId, caseType });
	} catch (err) {
		// A Project-membership denial (`gatedCaseStore` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		// See `populateSampleCasesAction` — a validation failure on
		// generated rows is a generator bug, so it alerts too.
		reportUnexpectedActionError(
			"resetSampleCases",
			err,
			{
				appId,
				caseType: caseType.name,
			},
			{ treatValidationAsBug: true },
		);
		return mapPopulateSampleCasesError(err);
	}
}

/**
 * List a case type's set-aside values (`parked_case_values` joined to
 * their live cases, verdicts computed server-side) for the review
 * screen AND the discovery surfaces — the Case data badge/popover
 * derive their active count from the same list so one invalidation
 * refreshes every representation. Timestamps cross as ISO strings to
 * keep the payload plain JSON.
 */
export async function loadParkedValuesAction(args: {
	appId: string;
	caseType: string;
}): Promise<LoadParkedValuesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, session.user.id, "view");
		const entries = await store.listParkedValues({
			appId: args.appId,
			caseType: args.caseType,
		});
		return {
			kind: "entries",
			entries: entries.map((entry) => ({
				...entry,
				createdAt: entry.createdAt.toISOString(),
				dismissedAt: entry.dismissedAt?.toISOString() ?? null,
			})),
		};
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("loadParkedValues", err, {
			appId: args.appId,
			caseType: args.caseType,
		});
		return {
			kind: "error",
			message:
				err instanceof Error ? err.message : "Failed to load set-aside values.",
		};
	}
}

/**
 * Restore set-aside values onto their cases. The store re-proves
 * every entry safe (row exists, key free, value conforms to the
 * CURRENT schema) — a blocked entry counts in `kept`, so a stale
 * client racing a teammate degrades to an honest partial rather than
 * an error. The client re-lists afterwards either way.
 */
export async function restoreParkedValuesAction(args: {
	appId: string;
	ids: string[];
}): Promise<RestoreParkedValuesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, session.user.id, "edit");
		const result = await store.restoreParkedValues({
			appId: args.appId,
			ids: args.ids,
		});
		return { kind: "restored", ...result };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("restoreParkedValues", err, {
			appId: args.appId,
		});
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to restore values.",
		};
	}
}

/**
 * Toggle the soft archive on set-aside entries — `dismissed: true`
 * for Dismiss (and its bulk form), `false` for the undo toast's
 * un-dismiss. Never deletes.
 */
export async function setParkedValuesDismissedAction(args: {
	appId: string;
	ids: string[];
	dismissed: boolean;
}): Promise<SetParkedValuesDismissedResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, session.user.id, "edit");
		const count = await store.setParkedValuesDismissed({
			appId: args.appId,
			ids: args.ids,
			dismissed: args.dismissed,
		});
		return { kind: "toggled", count };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("setParkedValuesDismissed", err, {
			appId: args.appId,
		});
		return {
			kind: "error",
			message:
				err instanceof Error ? err.message : "Failed to update the entries.",
		};
	}
}

/**
 * The Fix path: write a typed replacement value to the entry's case
 * through the standard validated update, then archive the entry (its
 * original value stays readable under Dismissed). Validation
 * failures come back as the typed `invalid-value` arm for inline
 * rendering in the Fix editor; a vanished entry (teammate restored
 * it, case row replaced) is the `not-found` arm — both expected
 * control flow, not faults.
 */
export async function replaceParkedValueAction(args: {
	appId: string;
	id: string;
	value: JsonValue;
}): Promise<ReplaceParkedValueResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, session.user.id, "edit");
		await store.replaceParkedValue({
			appId: args.appId,
			id: args.id,
			value: args.value,
		});
		return { kind: "replaced" };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		if (err instanceof CasePropertiesValidationError)
			return { kind: "invalid-value", failures: err.failures };
		if (err instanceof ParkedValueNotFoundError) return { kind: "not-found" };
		reportUnexpectedActionError("replaceParkedValue", err, {
			appId: args.appId,
		});
		return {
			kind: "error",
			message:
				err instanceof Error ? err.message : "Failed to save the replacement.",
		};
	}
}

/**
 * Load Filters-section authoring-surface live-preview rows + the
 * full matching count. Resolves the request's session, constructs
 * a Project-scoped `CaseStore` via `gatedCaseStore` (view),
 * and delegates to `readFilterPreview` which routes through
 * `caseStore.query` (row sample) + `caseStore.count`
 * (totality figure) — both compile the same predicate through the
 * same stack so the count + row-list pair is internally consistent.
 *
 * At the wire boundary, both the case-list config and blueprint are
 * parsed before they reach the predicate compiler. Session resolution
 * happens first, matching every other action in this file, so an expired
 * session returns `unauthenticated` without doing parse or store work.
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
	excludedOwnerIdsExpression?: ValueExpression;
	limit?: number;
	/** Viewer IANA timezone for `format-date` rendering; UTC when omitted. */
	viewerTimeZone?: string;
}): Promise<LoadFilterPreviewResult> {
	try {
		// Session-first matches every other action in this file. An
		// unauthenticated request short-circuits before the parse
		// work runs.
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };

		// Wire-boundary parse. `caseListConfig` comes first because its
		// shape is structurally independent of the blueprint.
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
		// parse. The helper is
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

		const store = await gatedCaseStore(args.appId, session.user.id, "view");
		const searchSession = previewSearchSessionValues(session.user);
		const excludedOwnerIds =
			args.excludedOwnerIdsExpression === undefined
				? undefined
				: parseExcludedOwnerIds(
						evaluatePreviewSearchExpression(
							args.excludedOwnerIdsExpression,
							searchSession,
						),
					);
		// `buildCaseTypeMap` reads only `caseTypes`, so the parsed
		// persistable shape goes through directly.
		return await readFilterPreview(store, {
			appId: args.appId,
			caseType: args.caseType,
			limit: args.limit,
			caseListConfig: parsedConfig.data,
			bindings: previewCaseStoreBindings(
				searchSession,
				parsedConfig.data.searchInputs,
				withSearchInputExpressionValues(
					parsedConfig.data.searchInputs,
					new Map(),
				),
				args.viewerTimeZone,
			),
			excludedOwnerIds,
			caseTypeSchemas: buildCaseTypeMap(parsedBlueprint.data),
		});
	} catch (err) {
		// A Project-membership denial (`gatedCaseStore` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("loadFilterPreview", err, {
			appId: args.appId,
			caseType: args.caseType,
		});
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
		const store = await gatedCaseStore(appId, session.user.id, "edit");
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
		// A Project-membership denial (`gatedCaseStore` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		// Form submit: `CasePropertiesValidationError` is ordinary
		// user error (the submitted values failed the schema), so it
		// stays un-alerted — only raw DB / invariant failures report.
		reportUnexpectedActionError("submitForm", err, { appId });
		return mapSubmitFormError(err);
	}
}
