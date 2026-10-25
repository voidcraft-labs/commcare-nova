// lib/preview/engine/searchExpressionEvaluation.ts
//
// Runtime evaluation for the case-search expression surfaces: prompt
// defaults and hidden values, the excluded-owner expression, prompt
// conditions and checks, and lookup-backed prompt choices. The device
// evaluates each over its query screen's instances, so Preview prints the
// stored tree with the shared wire emitter at the Preview target and
// evaluates that text over the same instances
// (`xpathInstances.ts::searchScreenXPathInstances`): the session, the
// answers as `search-input:results`, and the lookup fixtures under their
// suite ids. Nothing is substituted or folded into the tree first.
//
// There is no case row on this screen. Search prompt defaults and hidden
// query values run against the session and search-input instances, not
// against a selected case.

import { lookupTypeIndexFromNaming } from "@/lib/commcare/lookup/naming";
import { lookupOptionsNodeset } from "@/lib/commcare/lookupOptions";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	ownRecordValue,
	type SearchInputDef,
	type SelectSearchInputDef,
	searchInputDefault,
	searchInputLookupSortColumnId,
} from "@/lib/domain";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import type {
	Expression,
	ModuleExpressionSlotRef,
	SessionContextField,
} from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import { toBoolean, xpathToString } from "@/lib/preview/xpath/coerce";
import { evaluate, evaluateRuntime } from "@/lib/preview/xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "@/lib/preview/xpath/generatedJavaRosaFunctions";
import type { XPathInstance } from "@/lib/preview/xpath/runtimeValues";
import { dayNumberEpochOf, type EvalContext } from "@/lib/preview/xpath/types";
import { snapshotXPathWorkerInstance } from "@/lib/preview/xpath/workerProjection";
import type { XPathWorkerInstances } from "@/lib/preview/xpath/workerProtocol";
import {
	type PreviewSearchSessionValues,
	previewUserPropertySlugMap,
} from "./identity";
import {
	expressionLookupsCovered,
	type LookupChoice,
	lookupChoicesFromNodeset,
	lookupOptionsSourceCovered,
	type PreviewLookupData,
} from "./lookupEvaluation";
import type { SearchInputValues } from "./runtimeBindings";
import { searchInputInstanceValues } from "./runtimeBindings";
import {
	type CaseDatabaseSnapshot,
	SEARCH_INPUT_INSTANCE_ID,
	searchScreenXPathInstances,
} from "./xpathInstances";

/** Bulk helpers evaluate several different slots. Each one obtains its own
 * context from the same saved module and held lookup snapshot. */
export interface PreviewSearchEnvironment {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly lookup?: PreviewLookupData;
	/** The session datums chosen before this Search screen, `session/data`:
	 * the map `entrySessionData.ts::caseListStepSession` builds for the
	 * module's case list step. */
	readonly sessionData?: Readonly<Record<string, string>>;
	/** The device's cases and places, where the evaluator holds them (the
	 * browser does; the server's Results read does not). `null` while the
	 * snapshot loads. */
	readonly caseDatabase?: CaseDatabaseSnapshot | null;
}

/**
 * One Search screen evaluation: the printed text and the instances it reads.
 * A caller with another evaluator (the XPath worker, for a pattern-bearing
 * constraint) runs the same text over the same instances.
 */
export interface SearchScreenXPath {
	readonly source: string;
	readonly instances: ReadonlyMap<string, XPathInstance>;
}

function searchInputContext(
	environment: PreviewSearchEnvironment,
	searchInputUuid: Uuid,
	slot: Extract<
		ModuleExpressionSlotRef,
		{ member: { searchInputUuid: Uuid } }
	>["slot"],
): ExpressionContext {
	const context = slotContext(
		environment.doc,
		{
			entity: "module",
			uuid: environment.moduleUuid,
			slot,
			member: { searchInputUuid },
		},
		environment.lookup === undefined
			? new Map()
			: (lookupTypeIndexFromNaming(environment.lookup.naming) ?? new Map()),
	);
	if (context === undefined)
		throw new Error(
			`Search input '${searchInputUuid}' has no '${slot}' evaluation context in this module.`,
		);
	return context;
}

/** The worker request world of one Search screen evaluation: its instances
 * as structured-clone snapshots, with no main instance and no context node. */
export function searchScreenWorkerInstances(
	xpath: SearchScreenXPath,
): XPathWorkerInstances {
	return {
		secondary: [...xpath.instances.values()].map(snapshotXPathWorkerInstance),
		contextPath: "",
		position: 1,
	};
}

/** Print a Search screen tree as the device reads it, at the Preview
 * target: answers through `search-input:results`, lookups through their
 * suite fixture ids. */
function printSearchScreenTree(wire: WireExpr): string {
	return serializeWire(wire, { target: "preview" }).text;
}

function searchScreenTree(
	expression: Expression,
	types: ExpressionContext,
	session: PreviewSearchSessionValues,
	lookupData: PreviewLookupData | undefined,
): WireExpr {
	return toWire(expression, {
		target: "preview",
		types,
		bindings: {
			searchInputInstanceId: SEARCH_INPUT_INSTANCE_ID,
			userPropertySlugs: previewUserPropertySlugMap(session),
			...(lookupData === undefined
				? {}
				: {
						lookup: { naming: lookupData.naming, instanceScope: "suite" },
					}),
		},
	});
}

/** The structural world of the Search screen: no case row and no form
 *  instance, only the named instances the device's query screen holds,
 *  counting day numbers from its platform's epoch. */
function searchScreenEvalContext(
	instances: ReadonlyMap<string, XPathInstance>,
	session: PreviewSearchSessionValues,
): EvalContext {
	return {
		contextPath: "",
		position: 1,
		getValue: () => undefined,
		resolveXPathInstance: (instanceId) => instances.get(instanceId),
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
		dayNumberEpoch: dayNumberEpochOf(session),
	};
}

/**
 * Evaluate one search expression over the Search screen's instances, with
 * `inputValues` as the answers the search-input instance holds (a completed
 * date range as Core's one `__range__` value).
 */
export function evaluatePreviewSearchExpression(
	expression: Expression,
	types: ExpressionContext,
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
	searchInputs: readonly SearchInputDef[] = [],
	lookupData?: PreviewLookupData,
	sessionData?: Readonly<Record<string, string>>,
): string {
	const instances = searchScreenXPathInstances({
		session,
		answers: searchInputInstanceValues(searchInputs, inputValues),
		...(lookupData === undefined ? {} : { lookupData }),
		...(sessionData === undefined ? {} : { sessionData }),
	});
	return xpathToString(
		evaluate(
			printSearchScreenTree(
				searchScreenTree(expression, types, session, lookupData),
			),
			searchScreenEvalContext(instances, session),
		),
	);
}

/**
 * Evaluate a search-screen predicate against the same values CommCare exposes
 * while the worker is filling the search form. Input reads see the live
 * draft, a completed date range as Core's one value; session reads see the
 * authenticated preview worker. There is no selected case on this screen.
 */
export function evaluatePreviewSearchPredicate(
	predicate: Expression,
	types: ExpressionContext,
	environment: PreviewSearchEnvironment,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
): boolean {
	const xpath = emitPreviewSearchPredicate(
		predicate,
		types,
		environment,
		searchInputs,
		session,
		inputValues,
	);
	return toBoolean(
		evaluate(xpath.source, searchScreenEvalContext(xpath.instances, session)),
	);
}

/**
 * The text a search-screen predicate evaluates as, with the instances it
 * reads, so that a caller with a different evaluator (the XPath worker, for
 * a pattern-bearing constraint) runs the same bytes over the same world the
 * scalar path does.
 *
 * A hidden input the bag does not carry is seeded here: the device holds
 * every hidden prompt's value from the moment it builds the query screen
 * (`org/commcare/session/RemoteQuerySessionManager.java::initUserAnswers`,
 * which `util/screen/QueryScreen.java::init` reaches through
 * `buildQuerySessionManager`), so a condition reading one judges the seeded
 * value before the worker searches, not blank. A bag that already carries
 * the value (the submitted answers) keeps it.
 */
export function emitPreviewSearchPredicate(
	predicate: Expression,
	types: ExpressionContext,
	environment: PreviewSearchEnvironment,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
): SearchScreenXPath {
	const lookupData = environment.lookup;
	return {
		source: printSearchScreenTree(
			searchScreenTree(predicate, types, session, lookupData),
		),
		instances: searchScreenXPathInstances({
			session,
			answers: searchInputInstanceValues(
				searchInputs,
				withSeededHiddenValues(searchInputs, inputValues, session, environment),
			),
			...(lookupData === undefined ? {} : { lookupData }),
			...(environment.sessionData === undefined
				? {}
				: { sessionData: environment.sessionData }),
		}),
	};
}

/** The bag with every hidden input it lacks resolved in, or the bag
 *  itself when it already holds them all (or there are none). */
function withSeededHiddenValues(
	searchInputs: readonly SearchInputDef[],
	inputValues: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
): SearchInputValues {
	const missing = searchInputs.filter(
		(input) => input.kind === "hidden" && !inputValues.has(input.name),
	);
	if (missing.length === 0) return inputValues;
	return new Map([
		...inputValues,
		...resolveSearchHiddenValues(missing, session, environment),
	]);
}

/**
 * Resolve the session-instance path spellings the on-device emitters
 * print (`instance('commcaresession')/session/...`; the explicit instance
 * resolver receives `/session/...`). Shared with every
 * preview surface that evaluates emitted predicates outside a form
 * context; non-session paths return `undefined` so callers can chain
 * their own resolution.
 */
export function sessionInstancePathValue(
	path: string,
	session: PreviewSearchSessionValues,
	/** The entry's session map, `session/data/<id>` → value. */
	data: Readonly<Record<string, string>> = {},
): string | undefined {
	const dataPrefix = "/session/data/";
	if (path.startsWith(dataPrefix)) {
		return ownRecordValue(data, path.slice(dataPrefix.length));
	}

	const contextPrefix = "/session/context/";
	if (path.startsWith(contextPrefix)) {
		const field = path.slice(contextPrefix.length) as SessionContextField;
		return session.context[field];
	}

	const userPrefix = "/session/user/data/";
	if (path.startsWith(userPrefix)) {
		return ownRecordValue(session.user, path.slice(userPrefix.length));
	}

	return undefined;
}

/**
 * Resolve prompt defaults in displayed order. CommCare evaluates every prompt
 * default against the session context before it constructs the search-input
 * instance, so sibling defaults do not feed one another. Preview mirrors that
 * lifecycle by evaluating each expression with an empty input bag.
 *
 * Date-range inputs stay empty because their final schema has no scalar
 * default slot.
 */
export function resolveSearchInputDefaults(
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
): SearchInputValues {
	const lookupData = environment.lookup;
	const values = new Map<string, string>();
	for (const input of [...searchInputs]) {
		const inputDefault = searchInputDefault(input);
		if (inputDefault === undefined) continue;
		/* A default whose carriers the held snapshot doesn't COVER (not
		 * loaded yet, or a valid edit the stale-while-revalidate snapshot
		 * predates) contributes nothing THIS resolution; the run-state
		 * reconciler updates untouched prompts when the covering snapshot
		 * lands and the defaults revision moves. */
		if (!expressionLookupsCovered(inputDefault, lookupData)) {
			continue;
		}
		const value = evaluatePreviewSearchExpression(
			inputDefault,
			searchInputContext(environment, input.uuid, "search_input_default"),
			session,
			undefined,
			undefined,
			lookupData,
			environment.sessionData,
		).trim();
		if (value === "") continue;
		values.set(input.name, value);
	}
	return values;
}

/**
 * Resolve every hidden input's system-generated value at the moment the
 * worker searches. CommCare seeds a hidden prompt's `default` into the
 * answers when it builds the query screen and re-evaluates it on every
 * rebuild (`util/screen/QueryScreen.java::init`), so the value a search
 * carries is the one current when the worker pressed Search, never a
 * value typed by the worker. A hidden input reads no sibling answer
 * (the validator refuses `input(...)` in its value), so each expression
 * evaluates over the session alone. A value whose lookup carriers the
 * held snapshot does not cover contributes nothing this resolution; a
 * blank result is omitted, matching an unanswered prompt.
 */
export function resolveSearchHiddenValues(
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
): SearchInputValues {
	const lookupData = environment.lookup;
	const values = new Map<string, string>();
	for (const input of searchInputs) {
		if (input.kind !== "hidden") continue;
		if (!expressionLookupsCovered(input.value, lookupData)) continue;
		const value = evaluatePreviewSearchExpression(
			input.value,
			searchInputContext(environment, input.uuid, "search_input_hidden_value"),
			session,
			undefined,
			undefined,
			lookupData,
			environment.sessionData,
		);
		if (value === "") continue;
		values.set(input.name, value);
	}
	return values;
}

/**
 * The choices a lookup-backed Search prompt offers right now: the source
 * table's rows in the order of the sort column's text (the label column's
 * when none is chosen), as the device lists them, filtered by the authored row filter over
 * table columns and session values (the search screen has no case and the
 * filter admits no sibling answer). `undefined` while the held snapshot
 * does not cover the source, which the widget renders as its loading
 * state; blank or duplicate values stay in the list, exactly as the device
 * fixture would carry them.
 */
export function resolveSearchInputChoices(
	input: SelectSearchInputDef,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
): readonly LookupChoice[] | undefined {
	const lookupData = environment.lookup;
	const sortColumnId = searchInputLookupSortColumnId(input.options);
	if (
		lookupData === undefined ||
		!lookupOptionsSourceCovered(input.options, lookupData, sortColumnId)
	) {
		return undefined;
	}
	const instances = searchScreenXPathInstances({
		session,
		answers: new Map(),
		lookupData,
		...(environment.sessionData === undefined
			? {}
			: { sessionData: environment.sessionData }),
	});
	const nodeset = printSearchScreenTree(
		lookupOptionsNodeset(input.options, {
			target: "preview",
			types: searchInputContext(
				environment,
				input.uuid,
				"search_input_options",
			),
			naming: lookupData.naming,
			instanceScope: "suite",
			bindings: { userPropertySlugs: previewUserPropertySlugMap(session) },
		}),
	);
	return lookupChoicesFromNodeset(
		input.options,
		lookupData,
		evaluateRuntime(nodeset, searchScreenEvalContext(instances, session)),
		sortColumnId,
	);
}

/** CCHQ splits this one niche value on whitespace only; commas remain ids. */
export function parseExcludedOwnerIds(value: string): readonly string[] {
	return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}
