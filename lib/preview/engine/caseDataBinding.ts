// lib/preview/engine/caseDataBinding.ts
//
// Server Actions for the running-app view's case-data binding.
// Each action derives the acting `ResolvedPreviewIdentity` at its own
// boundary — never from a client-supplied identity. Persona-aware running
// paths use `resolveAuthorizedPreviewContext`, which proves the signed-in
// member's access before reading the committed blueprint, resolves a persona
// selector from that one authorized snapshot, and binds actor + owner
// explicitly. Member-only paths use `resolvePreviewIdentity` +
// `gatedCaseStore`. Both construct a Project-scoped `withProjectContext`
// store wrapped in `schemaHealingCaseStore` (every individual store call
// self-heals a missing or stale schema row and retries itself once) and
// delegate to an I/O helper in
// `./caseDataBindingHelpers.ts` (server-only) or an error mapper in
// `./caseDataBindingClient.ts` (client-bundle-safe). A membership
// denial surfaces as the IDOR-safe not-found `error` arm. Tests bypass
// the actions and inject a `CaseStore` directly. Centralizing identity
// + membership resolution in these two modules means a change to the
// auth strategy lands in one place.

"use server";

import { getSession } from "@/lib/auth-utils";
import {
	buildCaseTypeMap,
	CaptureSubmissionRejectedError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CaseStore,
	type JsonValue,
	ParkedValueNotFoundError,
	type TermBindings,
} from "@/lib/case-store";
import { prepareCaptureSubmissionBytes } from "@/lib/case-store/postgres/submissionAttachments";
import { adjudicateSubmissionReceipt } from "@/lib/case-store/submission";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	FormAttachmentWriteRejectedError,
	loadAuthorizedFormSubmissionSnapshot,
} from "@/lib/db/formAttachments";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type {
	BlueprintDoc,
	CaseListConfig,
	CasePropertyDataType,
	CaseType,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import {
	caseListConfigSchema,
	ownRecordValue,
	personasOf,
	recordFromEntries,
	searchInputRuntimeValueType,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import type { ValueExpression } from "@/lib/domain/predicate";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import { XML_ELEMENT_NAME_PATTERN } from "@/lib/domain/predicate/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { validateCaptureSubmissionProjection } from "./captureSubmissionValidation";
import {
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
} from "./caseDataBindingClient";
import {
	buildSubmissionOperationProgram,
	buildSubmissionReceiptIdentity,
	collectConfigLookupTableIds,
	gatedCaseStore,
	gatedCaseStoreWithScope,
	loadExpressionLookupData,
	loadLookupTableSchemas,
	PERSONA_UNAVAILABLE_MESSAGE,
	readCaseData,
	readCaseDatabaseSnapshot,
	readCases,
	readFilterPreview,
	resetSampleCases,
	resolveAuthorizedPreviewContext,
	resolvePreviewIdentity,
	seedSampleCases,
	submissionEnvelopeArgs,
} from "./caseDataBindingHelpers";
import { reportUnexpectedActionError } from "./caseDataBindingTelemetry";
import type {
	ConversionImpactResult,
	LegacySingleCaseSubmissionMutation,
	LoadCaseCountResult,
	LoadCaseDataResult,
	LoadCasesResult,
	LoadFilterPreviewResult,
	LoadParkedValuesResult,
	LoadPersonaOwnedCaseCountResult,
	ParentCaseSelection,
	PopulateSampleCasesResult,
	ReplaceParkedValueResult,
	RestoreParkedValuesResult,
	SetParkedValuesDismissedResult,
	SubmissionMutation,
	SubmissionResult,
	SubmissionWireMutation,
} from "./caseDataBindingTypes";
import { SearchInputValuesError } from "./dateRangeInputValidation";
import type { PreviewSearchSessionValues } from "./identity";
import {
	previewAsMe,
	previewAsPersona,
	type ResolvedPreviewIdentity,
} from "./identity";
import {
	type SearchInputValues,
	type SearchInputValuesWire,
	searchInputValuesFromWire,
	withSearchInputExpressionValues,
} from "./runtimeBindings";
import {
	evaluatePreviewSearchExpression,
	parseExcludedOwnerIds,
} from "./searchExpressionEvaluation";
import {
	searchInputRuntimeGlobalError,
	searchInputSubmissionErrors,
} from "./searchInputValidation";
import type { LoadCaseDatabaseSnapshotResult } from "./xpathInstances";

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
	const boundInputs = new Map<Uuid, string>();
	for (const input of searchInputs) {
		boundInputs.set(input.uuid, inputValues.get(input.name) ?? "");
	}

	const sessionContext = new Map<string, string>();
	for (const [field, value] of Object.entries(session.context)) {
		if (value !== undefined) sessionContext.set(field, value);
	}

	return {
		searchInputs: boundInputs,
		sessionContext,
		sessionUser: new Map(Object.entries(session.user)),
		userPropertySlugs: new Map(Object.entries(session.userPropertySlugs)),
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
	/** Exact selected identities for a bounded, authoritative validation read. */
	caseIds?: readonly string[];
	caseListConfig?: CaseListConfig;
	inputValues?: SearchInputValuesWire;
	excludedOwnerIdsExpression?: ValueExpression;
	parentCase?: ParentCaseSelection;
	caseTypes?: readonly CaseType[];
	/** Bounded Results window. Omitted by the current unpaged form-selection caller. */
	page?: { offset: number; limit: number };
	/**
	 * The viewer's IANA timezone — drives `format-date` rendering in
	 * calculated columns (device-local parity). Omitted falls back to UTC.
	 */
	viewerTimeZone?: string;
	/** Which persona Preview is running as, if any. A SELECTOR — the
	 *  identity itself is resolved server-side from the committed doc. */
	personaUuid?: string;
}): Promise<LoadCasesResult> {
	try {
		const caseTypeSchemas =
			args.caseTypes && args.caseTypes.length > 0
				? new Map(args.caseTypes.map((ct) => [ct.name, ct]))
				: undefined;
		const inputValues = args.inputValues
			? searchInputValuesFromWire(args.inputValues)
			: undefined;
		const typeContext =
			args.caseListConfig === undefined
				? undefined
				: {
						caseTypes: [...(args.caseTypes ?? [])],
						knownInputs: args.caseListConfig.searchInputs.map((input) => ({
							uuid: input.uuid,
							name: input.name,
							data_type: searchInputRuntimeValueType(input),
						})),
						currentCaseType: args.caseType,
					};

		/* Reject caller-owned input/config failures before authorization opens a
		 * case store. Session-backed conditions are intentionally skipped here
		 * and evaluated again below with the resolved worker. */
		if (args.caseListConfig !== undefined) {
			const preliminaryGlobalError = searchInputRuntimeGlobalError(
				args.caseListConfig,
				args.caseType,
				inputValues ?? new Map(),
				undefined,
				typeContext,
				{ sessionIndependentOnly: true },
			);
			if (preliminaryGlobalError !== undefined) {
				return {
					kind: "invalid-search",
					message: preliminaryGlobalError,
					repair: "settings",
				};
			}
			if (inputValues !== undefined) {
				const preliminaryErrors = searchInputSubmissionErrors(
					args.caseListConfig,
					args.caseType,
					inputValues,
					undefined,
					typeContext,
					{ sessionIndependentOnly: true },
				);
				const firstError = preliminaryErrors.values().next().value;
				if (firstError !== undefined) {
					return {
						kind: "invalid-search",
						message: firstError,
						repair: "inputs",
					};
				}
			}
		}

		const context = await resolveAuthorizedPreviewContext({
			appId: args.appId,
			personaUuid: args.personaUuid,
			required: "view",
			loadBlueprint: true,
		});
		if (context.kind !== "ready") return context;
		const { identity, store, scope } = context;
		const searchSession = identity.session;
		if (args.caseListConfig !== undefined) {
			const globalRuntimeError = searchInputRuntimeGlobalError(
				args.caseListConfig,
				args.caseType,
				inputValues ?? new Map(),
				searchSession,
				typeContext,
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
			/* The full pass with the resolved worker. A pattern-bearing required
			 * condition or check stays unjudged here: the server holds no Java
			 * Pattern engine, so Preview's Search screen enforces those in its
			 * XPath worker, the way it alone enforces lookup-bearing ones. */
			const runtimeErrors = searchInputSubmissionErrors(
				args.caseListConfig,
				args.caseType,
				inputValues,
				searchSession,
				typeContext,
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
		/* Lookup carriers: the SQL-bound slots (filter / calc columns /
		 * advanced predicates) compile natively against a rows-free
		 * definitions snapshot; the excluded-owner expression evaluates
		 * scalar-side, so its carriers fold over loaded fixture rows. */
		const lookupTableSchemas = await loadLookupTableSchemas(
			scope,
			collectConfigLookupTableIds(args.caseListConfig),
		);
		const excludedLookupData = await loadExpressionLookupData(
			scope,
			args.excludedOwnerIdsExpression,
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
							excludedLookupData,
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
							excludedLookupData,
						),
					);
		return await readCases(store, {
			appId: args.appId,
			caseType: args.caseType,
			caseIds: args.caseIds,
			caseTypeSchemas,
			caseListConfig: args.caseListConfig,
			parentCase: args.parentCase,
			inputValues,
			bindings,
			lookupTableSchemas,
			excludedOwnerIds,
			authoredExcludedOwnerIds,
			// The running Results surface passes a bounded window. The form-selection
			// caller deliberately omits it because it needs the complete candidate set.
			page: args.page,
			restoreScope: context.restoreScope,
		});
	} catch (err) {
		// A Project-membership denial (`resolveAppScope` → `AppAccessError`)
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
 * Count the reachable base population for one case type, with no authored
 * filter applied. The builder's case-data manager leaves `parentCase`
 * undefined and uses the app-wide count as its source of truth. A nested
 * running Results probe supplies the selected parent set so an empty child list
 * is compared with the union of those exact direct non-extension child
 * populations, never with children belonging to a different parent.
 */
export async function loadCaseCountAction(args: {
	appId: string;
	caseType: string;
	/** Exact selected-parent scope for a nested running Results probe. */
	parentCase?: ParentCaseSelection;
	/** The builder's Case data manager passes true — it reports the
	 * full stored population it governs (replace-all deletes held rows
	 * too), with the held count named separately beside it. The
	 * running app's empty-state probe leaves it unset so "no cases
	 * exist" vs "your conditions exclude cases" attributes against the
	 * population the app can actually reach. */
	includeHeld?: boolean;
}): Promise<LoadCaseCountResult> {
	try {
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "view");
		const count = await store.count({
			appId: args.appId,
			caseType: args.caseType,
			parentCases: args.parentCase,
			includeHeld: args.includeHeld === true,
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
 * How many cases of one type carry NO connection with the given name.
 *
 * The measurement behind the grouping surface's second statement.
 * `string(./index/<id>)` evaluates to `""` for a case with no such
 * index, and the clustering map takes that as an ordinary key, so every
 * one of these lands in a single group on the device. Which cases those
 * are is runtime data, so the commit gate cannot speak to it
 * (`docs/architecture/contracts.md` § What the commit gate may
 * read) — the author is told the number instead.
 *
 * Held rows are counted: this answers a question about the stored data
 * an author governs, not about what the running app can currently reach.
 *
 * The identifier is caller-supplied, so it is checked here at the trust
 * boundary rather than trusted into a query. It reaches SQL as a bound
 * parameter either way; the check is what keeps a blank or malformed
 * name from quietly counting the whole population.
 */
export async function loadMissingConnectionCountAction(args: {
	appId: string;
	caseType: string;
	identifier: string;
}): Promise<LoadCaseCountResult> {
	if (!XML_ELEMENT_NAME_PATTERN.test(args.identifier)) {
		return {
			kind: "error",
			message:
				"A connection name must start with a letter or underscore and contain only letters, numbers, and underscores.",
		};
	}
	try {
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "view");
		const count = await store.count({
			appId: args.appId,
			caseType: args.caseType,
			missingIndexIdentifier: args.identifier,
		});
		return { kind: "count", count };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("loadMissingConnectionCount", err, {
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
 * How many retained cases one persona owns, including rows whose case type is
 * no longer materialized by the current blueprint.
 *
 * `owner_id` is the CommCare case-owner axis — never a tenant filter — so
 * this reads the caller's own Project through the same membership gate as
 * every other action and simply compares that column. The persona is named
 * by uuid; nothing about it authorizes the read.
 *
 * The persona selector is resolved from the authorized committed snapshot.
 * Neither its owner id nor a client-provided case-type list is trusted.
 */
export async function countCasesOwnedByAction(args: {
	appId: string;
	personaUuid: string;
}): Promise<LoadPersonaOwnedCaseCountResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId: args.appId,
			personaUuid: args.personaUuid,
			required: "view",
		});
		if (context.kind !== "ready") return context;
		const count = await context.store.count({
			appId: args.appId,
			ownerId: context.identity.ownerId,
			/* A held case is still owned. The confirmation is about what
			 * stays behind, and a row waiting in Data to review stays
			 * behind exactly like every other one. */
			includeHeld: true,
		});
		return { kind: "count", count };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("countCasesOwnedBy", err, {
			appId: args.appId,
		});
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to count cases.",
		};
	}
}

/**
 * The consent preview for a failable kind conversion: what retyping
 * `(caseType, property)` to `toType` would do to the stored rows —
 * counts + samples computed with the migration's own cast over the
 * migration's own population (held cases included), so the impact
 * dialog and the migration can't disagree about the same data.
 * Read-only; the convert itself commits through the ordinary gated
 * mutation path after the user agrees.
 */
export async function conversionImpactAction(args: {
	appId: string;
	caseType: string;
	property: string;
	toType: CasePropertyDataType;
}): Promise<ConversionImpactResult> {
	try {
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "view");
		const impact = await store.conversionImpact({
			appId: args.appId,
			caseType: args.caseType,
			property: args.property,
			toType: args.toType,
		});
		return { kind: "impact", ...impact };
	} catch (err) {
		if (err instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("conversionImpact", err, {
			appId: args.appId,
			caseType: args.caseType,
		});
		return {
			kind: "error",
			message:
				err instanceof Error ? err.message : "Failed to check saved data.",
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
	includeHeld?: boolean,
	/** Which persona Preview is running as, if any — a selector, never an
	 *  identity. */
	personaUuid?: string,
	/**
	 * True for the RUNNING app's screens, which may only open a case the
	 * worker's device would hold. The builder's review dialog leaves it unset
	 * and reads the tenant — it is looking at stored data on the author's
	 * behalf, not standing at a device.
	 *
	 * Explicit rather than inferred from `includeHeld`. A held case is
	 * definitionally not on a device, so today the two happen to coincide, but
	 * an authoring surface that opened an unheld case would then be scoped
	 * silently — and a case that quietly stops loading is the hardest kind of
	 * regression to attribute. Client-supplied is safe here: it can only
	 * narrow, and Project membership is what authorizes the read either way.
	 */
	deviceScoped?: boolean,
	/** Selected nested-menu parents. When present, the identity read must belong
	 * to their direct non-extension case-index population. */
	parentCase?: ParentCaseSelection,
): Promise<LoadCaseDataResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId,
			personaUuid,
			required: "view",
			loadBlueprint: true,
		});
		if (context.kind !== "ready") return context;
		const { identity, store, scope } = context;
		const lookupTableSchemas = await loadLookupTableSchemas(
			scope,
			collectConfigLookupTableIds(caseListConfig),
		);
		const searchSession = identity.session;
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
			parentCase,
			caseListConfig,
			includeHeld,
			lookupTableSchemas,
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
			...(deviceScoped === true && { restoreScope: context.restoreScope }),
		});
	} catch (err) {
		// A Project-membership denial (`resolveAppScope` → `AppAccessError`)
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

/** Load the selected worker's complete device casedb. The client supplies only
 * an app id plus optional persona selector; authorization, committed topology,
 * actor/owner separation, and restore-scope expansion are all server-owned. */
export async function loadCaseDatabaseSnapshotAction(
	appId: string,
	personaUuid?: string,
): Promise<LoadCaseDatabaseSnapshotResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId,
			personaUuid,
			required: "view",
			loadBlueprint: true,
		});
		if (context.kind !== "ready") return context;
		return {
			kind: "data",
			snapshot: await readCaseDatabaseSnapshot(context.store, {
				appId,
				restoreScope: context.restoreScope,
			}),
		};
	} catch (err) {
		if (err instanceof AppAccessError) {
			return { kind: "error", message: "App not found." };
		}
		reportUnexpectedActionError("loadCaseDatabaseSnapshot", err, { appId });
		return {
			kind: "error",
			message:
				err instanceof Error
					? err.message
					: "Failed to load the Preview case database.",
		};
	}
}

export async function populateSampleCasesAction(
	appId: string,
	caseType: CaseType,
	personaUuid?: string,
): Promise<PopulateSampleCasesResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId,
			personaUuid,
			required: "edit",
		});
		if (context.kind !== "ready") return context;
		// The LIVE `CaseType` definition comes straight from the client —
		// the generator reads only its property declarations + `parent_type`,
		// so the one catalog entry is all this needs (never the whole
		// blueprint). `resolveAuthorizedPreviewContext` verifies the actor holds
		// `edit` on the app's Project before binding the store, so a crafted `appId` for
		// another Project is rejected — the client-supplied id is otherwise
		// unchecked — and generated rows land in that shared Project's store.
		return await seedSampleCases(context.store, { appId, caseType });
	} catch (err) {
		// A Project-membership denial (`resolveAppScope` → `AppAccessError`)
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
	personaUuid?: string,
): Promise<PopulateSampleCasesResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId,
			personaUuid,
			required: "edit",
		});
		if (context.kind !== "ready") return context;
		return await resetSampleCases(context.store, { appId, caseType });
	} catch (err) {
		// A Project-membership denial (`resolveAppScope` → `AppAccessError`)
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
 * List a case type's kept values (`parked_case_values` joined to
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
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "view");
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
				err instanceof Error
					? err.message
					: "Couldn't load the data to review.",
		};
	}
}

/**
 * Restore kept values onto their cases. The store re-proves
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
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "edit");
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
 * Toggle the soft archive on kept entries — `dismissed: true`
 * for Dismiss (and its bulk form), `false` for the undo toast's
 * un-dismiss. Never deletes.
 */
export async function setParkedValuesDismissedAction(args: {
	appId: string;
	ids: string[];
	dismissed: boolean;
}): Promise<SetParkedValuesDismissedResult> {
	try {
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "edit");
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
 * The Replace path: write a typed replacement value to the entry's case
 * through the standard validated update, then archive the entry (its
 * original value stays readable under Dismissed). Validation
 * failures come back as the typed `invalid-value` arm for inline
 * rendering in the Replace editor; a vanished entry (teammate restored
 * it, case row replaced) is the `not-found` arm — both expected
 * control flow, not faults.
 */
export async function replaceParkedValueAction(args: {
	appId: string;
	id: string;
	value: JsonValue;
}): Promise<ReplaceParkedValueResult> {
	try {
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const store = await gatedCaseStore(args.appId, identity, "edit");
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
		// The entry lookup and the row write run in separate transactions,
		// so the case can vanish between them (a sample-data replace's
		// cascade) — the same "moved on" outcome as a vanished entry, not
		// a fault to surface raw.
		if (err instanceof CaseNotFoundError) return { kind: "not-found" };
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
		// work runs. The session is read ONCE and the identity rebuilt
		// from it below once the project space is known, so the two
		// resolutions cannot disagree about who is asking.
		const session = await getSession();
		if (session === null) return { kind: "unauthenticated" };
		const identity = previewAsMe(session.user);
		if (!identity) return { kind: "unauthenticated" };

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

		const {
			store,
			scope,
			projectId,
			role: accessRole,
		} = await gatedCaseStoreWithScope(args.appId, identity, "view");
		/* The filter preview compiles the SAME `#user/...` references the
		 * running app does, so it must bind the same project space. Left on
		 * the unthreaded identity, `commcare_project` compiled to empty here
		 * and to the real domain in the app, and an author would tune a
		 * filter against an answer their app never gives. */
		const projectSpace = await previewProjectSpaceFor({
			appId: args.appId,
			projectId,
			role: accessRole,
			actorUserId: identity.actorUserId,
		});
		/* The SAME session user, re-projected with the project space now
		 * that it is known. Rebuilding from the held session rather than
		 * re-resolving means there is no second read to fail and no
		 * fallback to an unthreaded identity — a fallback would compile
		 * `#user/commcare_project` as absent and show the author a row set
		 * the running app never shows, with no sign anything degraded. */
		const boundIdentity = previewAsMe(session.user, undefined, projectSpace);
		if (!boundIdentity) return { kind: "unauthenticated" };
		const lookupTableSchemas = await loadLookupTableSchemas(
			scope,
			collectConfigLookupTableIds(parsedConfig.data),
		);
		const excludedLookupData = await loadExpressionLookupData(
			scope,
			args.excludedOwnerIdsExpression,
		);
		const searchSession: PreviewSearchSessionValues = {
			...boundIdentity.session,
			// This action intentionally previews the parsed candidate document,
			// so immutable worker references must resolve through that candidate's
			// catalog. Authorization still belongs to the server-resolved member.
			userPropertySlugs: recordFromEntries(
				userPropertySlugsByUuid(parsedBlueprint.data),
			),
		};
		const excludedOwnerIds =
			args.excludedOwnerIdsExpression === undefined
				? undefined
				: parseExcludedOwnerIds(
						evaluatePreviewSearchExpression(
							args.excludedOwnerIdsExpression,
							searchSession,
							undefined,
							undefined,
							excludedLookupData,
						),
					);
		// `buildCaseTypeMap` reads only `caseTypes`, so the parsed
		// persistable shape goes through directly.
		return await readFilterPreview(store, {
			appId: args.appId,
			caseType: args.caseType,
			limit: args.limit,
			caseListConfig: parsedConfig.data,
			lookupTableSchemas,
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
		// A Project-membership denial (`resolveAppScope` → `AppAccessError`)
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
 * Apply one form submission through the case-store's atomic envelope.
 * `submissionEnvelopeArgs` projects the engine's `SubmissionMutation`
 * onto `CaseStore.applySubmission`, which lands the whole submission —
 * primary write, every child insert, and close's lifecycle transition
 * — in ONE Postgres transaction; partial success is unobservable and
 * the running-app view re-queries one settled state on resolve.
 * An authorized, committed operation- and attachment-free survey still crosses
 * the atomic envelope so a receipt committed after the action snapshot is
 * adjudicated before it returns. An attachment-bearing survey uses that same
 * envelope so its durable capture intent commits with the submission receipt.
 *
 * Caller-supplied `appId` is passed through verbatim, matching the
 * shape the other Server Actions in this file use. The bound
 * `CaseStore` enforces tenant scoping at the SQL layer; the action
 * does not re-check `appId` against `mutation.caseIds` for
 * followup / close.
 */
/** Normalize the only retired submission slot that must survive a deploy for
 * an already-open FormScreen. The raw object remains separate: receipt hashes
 * are protocol history, so a response-lost request has to hash exactly as the
 * deployment that first accepted it did. */
function normalizeSubmissionWireMutation(
	mutation: SubmissionWireMutation,
): SubmissionMutation {
	if (mutation.kind !== "followup" && mutation.kind !== "close") {
		return mutation;
	}
	const record = mutation as unknown as Record<string, unknown>;
	const hasCaseIds = Object.hasOwn(record, "caseIds");
	const hasCaseId = Object.hasOwn(record, "caseId");
	if (hasCaseIds && hasCaseId) {
		throw new CaptureSubmissionRejectedError(
			"A form submission cannot name both one case and a case selection.",
		);
	}
	if (hasCaseIds) return mutation as SubmissionMutation;
	if (
		!hasCaseId ||
		typeof record.caseId !== "string" ||
		record.caseId.length === 0
	) {
		throw new CaptureSubmissionRejectedError(
			"A followup or close submission requires at least one selected case.",
		);
	}
	const legacyMutation = mutation as LegacySingleCaseSubmissionMutation;
	if (legacyMutation.kind === "followup") {
		const { caseId, ...canonicalSlots } = legacyMutation;
		return { ...canonicalSlots, caseIds: [caseId] };
	}
	const { caseId, ...canonicalSlots } = legacyMutation;
	return { ...canonicalSlots, caseIds: [caseId] };
}

export async function submitFormAction(
	mutation: SubmissionMutation,
	appId: string,
	expectedBlueprintDigest: string,
	viewerTimeZone?: string,
	/** Which persona Preview is running as, if any. This one matters most:
	 *  the resolved identity's `ownerId` is stamped on every case the
	 *  submission creates, so a persona's work belongs to that persona. */
	personaUuid?: string,
): Promise<SubmissionResult> {
	try {
		/* This runtime boundary is mandatory even though the TypeScript surface
		 * is required: Server Action payloads are untrusted JSON. Consume the
		 * normalized projection below so missing/stale clients cannot bypass
		 * receipt, capture-intent, or committed-operation derivation. */
		const wireMutation = mutation as unknown as SubmissionWireMutation;
		const projection = validateCaptureSubmissionProjection(wireMutation);
		const normalizedMutation = normalizeSubmissionWireMutation(wireMutation);
		if (!/^[a-f0-9]{64}$/.test(expectedBlueprintDigest)) {
			return {
				kind: "blueprint-changed",
				message:
					"This app changed before the form could submit. Wait for it to finish saving, then try again.",
			};
		}
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const authorized = await loadAuthorizedFormSubmissionSnapshot({
			appId,
			actorUserId: session.user.id,
			entryKey: projection.entryKey,
		});
		if (authorized.kind === "replay") {
			/* Receipt identity deliberately does not consult today's topology.
			 * Try the selected persona identity first, then the only fallback a
			 * prior submission could have used when that selection named
			 * nothing. This preserves an exact replay after either the persona or
			 * the capture question is removed without accepting changed input. */
			const previewAsMember = previewAsMe(session.user);
			if (previewAsMember === null) return { kind: "unauthenticated" };
			const replayIdentities =
				personaUuid === undefined
					? [previewAsMember]
					: [
							{
								...previewAsMember,
								ownerId: personaUuid,
								personaUuid,
							},
							previewAsMember,
						];
			for (const replayIdentity of replayIdentities) {
				const receipt = buildSubmissionReceiptIdentity({
					appId,
					identity: replayIdentity,
					mutation: wireMutation,
					projection,
					viewerTimeZone,
				});
				const verdict = adjudicateSubmissionReceipt(
					receipt,
					authorized.receipt,
				);
				if (verdict.kind === "replay") {
					return submissionResultFromEnvelope(
						normalizedMutation,
						verdict.result,
						expectedBlueprintDigest,
					);
				}
			}
			throw new CaptureSubmissionRejectedError(
				"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
			);
		}
		if (
			canonicalJsonDigest(
				toPersistableDoc(authorized.app.blueprint as BlueprintDoc),
			) !== expectedBlueprintDigest
		) {
			return {
				kind: "blueprint-changed",
				message:
					"This app changed before the form could submit. Wait for it to finish saving, then try again.",
			};
		}
		/* Same project space the rest of Preview resolves, so a submission's
		 * conditions read `commcare_project` exactly as the form engine did
		 * when it showed them. The receipt digest covers only the actor,
		 * owner, and persona, so this cannot disturb replay. */
		const projectSpace = await previewProjectSpaceFor({
			appId,
			projectId: authorized.projectId,
			role: authorized.role,
			actorUserId: session.user.id,
		});
		let identity: ResolvedPreviewIdentity | null;
		if (personaUuid === undefined) {
			identity = previewAsMe(
				session.user,
				authorized.app.blueprint,
				projectSpace,
			);
		} else {
			const persona = ownRecordValue(
				personasOf(authorized.app.blueprint),
				personaUuid,
			);
			if (persona === undefined) {
				return {
					kind: "persona-unavailable",
					message: PERSONA_UNAVAILABLE_MESSAGE,
				};
			}
			identity = previewAsPersona(
				session.user,
				persona,
				authorized.app.blueprint,
				projectSpace,
			);
		}
		if (!identity) return { kind: "unauthenticated" };
		/* Membership BEFORE the program build: the build reads the
		 * committed doc, and the survey short-circuit below reflects that
		 * doc's contents — distinguishable arms a non-member must never
		 * reach, or the IDOR-safe not-found collapse leaks whether a
		 * foreign form carries operations. The same call yields the
		 * `LookupScope` the program's definition snapshot loads under. */
		const { store, scope } = await gatedCaseStoreWithScope(
			appId,
			identity,
			"edit",
		);
		const built = await buildSubmissionOperationProgram({
			appId,
			committedApp: authorized.app,
			blueprintDigest: expectedBlueprintDigest,
			identity,
			lookupScope: scope,
			mutation: normalizedMutation,
			receiptMutation: wireMutation,
			projection,
			viewerTimeZone,
		});
		if (built.captureIntent !== undefined) {
			await prepareCaptureSubmissionBytes({
				appId,
				projectId: authorized.projectId,
				actorUserId: identity.actorUserId,
				intent: built.captureIntent,
			});
		}
		// The schema heal wraps `applySubmission` at the envelope
		// boundary: the whole submission is one transaction, so a heal
		// retry re-runs the whole envelope with nothing partial persisted.
		const result = await store.applySubmission(
			submissionEnvelopeArgs(normalizedMutation, appId, built),
		);

		return submissionResultFromEnvelope(
			normalizedMutation,
			result,
			expectedBlueprintDigest,
		);
	} catch (err) {
		// A Project-membership denial (`resolveAppScope` → `AppAccessError`)
		// is expected, not a fault: collapse it to the IDOR-safe not-found
		// `error` arm WITHOUT alerting (`reportUnexpectedActionError`).
		if (
			err instanceof AppAccessError ||
			err instanceof FormAttachmentWriteRejectedError
		)
			return { kind: "error", message: "App not found." };
		// Form submit: `CasePropertiesValidationError` is ordinary
		// user error (the submitted values failed the schema), so it
		// stays un-alerted — only raw DB / invariant failures report.
		reportUnexpectedActionError("submitForm", err, { appId });
		return mapSubmitFormError(err);
	}
}

function submissionResultFromEnvelope(
	mutation: SubmissionMutation,
	result: Awaited<ReturnType<CaseStore["applySubmission"]>>,
	expectedBlueprintDigest: string,
): SubmissionResult {
	if (result.blueprintDigest !== expectedBlueprintDigest) {
		return {
			kind: "blueprint-changed",
			message:
				"Your answers were saved, but this app changed before the next screen could be chosen. Reload the app to continue.",
		};
	}
	/* New receipts always carry this exact in-transaction patch. Historical
	 * receipts do not: keep their replay deterministic with an empty patch
	 * rather than reading today's rows and pretending they were submission-time
	 * state. */
	const caseDatabasePatch = result.caseDatabasePatch;
	const childCaseIds =
		result.legacyChildCaseIds ??
		result.createdChildren.map((createdChild) => createdChild.caseId);
	if (mutation.kind === "survey") {
		return {
			kind: "survey",
			...(caseDatabasePatch === undefined ? {} : { caseDatabasePatch }),
		};
	}
	if (result.primaryCaseIds.length === 0) {
		throw new Error(
			unhandledKindMessage({
				where: "preview.caseDataBinding.submitFormAction",
				family: "SubmissionEnvelopeResult",
				received: "no primaryCaseIds on a case-bearing submission",
				knownKinds: ["registration", "followup", "close"],
			}),
		);
	}
	if (mutation.kind === "registration") {
		if (result.primaryCaseIds.length !== 1) {
			throw new Error(
				"A registration submission returned more than one primary case.",
			);
		}
		return {
			kind: "registration",
			caseId: result.primaryCaseIds[0] as string,
			childCaseIds,
			...(result.legacyChildCaseIds === undefined
				? { createdChildren: result.createdChildren }
				: {}),
			...(caseDatabasePatch === undefined ? {} : { caseDatabasePatch }),
		};
	}
	return {
		kind: mutation.kind,
		caseIds: result.primaryCaseIds,
		...(result.primaryCaseIds.length === 1
			? { caseId: result.primaryCaseIds[0] as string }
			: {}),
		childCaseIds,
		...(result.legacyChildCaseIds === undefined
			? { createdChildren: result.createdChildren }
			: {}),
		...(caseDatabasePatch === undefined ? {} : { caseDatabasePatch }),
	};
}
