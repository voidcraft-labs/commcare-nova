/**
 * The rows of a search's `_xpath_query`, placed conjunct by conjunct. HQ
 * joins every row with `and` (`case_search/utils.py::_apply_filter`), so the
 * unit placed is a top-level conjunct: Nova's zero-input row (A), a clause of
 * the case list filter restated (B), a simple Search field's derivation (C),
 * a condition that reads Search fields (D), a filter of the search's own on a
 * menu whose forms read the search (F), or a conjunct with no Nova slot (E).
 * Each placement is a proposal judged by Nova's own emission of the menu's
 * rows (`expressions/searchRows.ts::matchSearchRows`).
 */

import type {
	BlueprintDoc,
	Expression,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { literalInstantMicros } from "@/lib/domain/expression/instantOperand";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import {
	isRelationPath,
	type RelationPath,
} from "@/lib/domain/expression/types";
import {
	substituteUnansweredSearchInputs,
	walkExpressionNodes,
	walkExpressionTerms,
} from "@/lib/domain/expression/walk";
import {
	effectiveCaseSearchConfig,
	moduleFormsReadSearch,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	type SearchInputMode,
	type SimpleSearchInputDef,
} from "@/lib/domain/modules";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import {
	readsSearchField,
	replaceCaseConditions,
	searchConditionOf,
} from "@/lib/domain/searchConditions";
import { USERCASE_BUILT_IN_KEYS } from "@/lib/domain/usercase";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { advancedFormLoads } from "../../advancedSelections";
import {
	EMISSION_REWRITES,
	type EmissionRewriteId,
} from "../../emissionRewrites";
import {
	type ModuleExpressionContexts,
	moduleExpressionContexts,
} from "../../expressionContext";
import { projectCaseListForHq } from "../../hqJson/caseList";
import { HqXPath, hqXPath, hqXPathText } from "../../hqJson/xpath";
import { type SourceTable, tableOf } from "../../sourceKeys";
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "../../suite/case-search/simpleArmDerivation";
import { ZERO_INPUT_SEARCH_SENTINEL } from "../../suite/case-search/xpathQuery";
import { inventoryIndex } from "../../surface/inventory";
import { dateAddOnDeviceCompatibility } from "../../validator/rules/case-list/dateAddOnDeviceCompatibility";
import { matchModeOnDeviceCompatibility } from "../../validator/rules/case-list/matchModeOnDeviceCompatibility";
import { onDeviceExpressionCompatibility } from "../../validator/rules/case-list/onDeviceExpressionCompatibility";
import { unguardedSearchInputReads } from "../../validator/rules/case-list/searchInputRefUsesWhenInputPresent";
import { rethrowWorkStop } from "../../workMeter";
import type { FormSyntax } from "../../xpath/formSyntax";
import type { ClaimSite } from "../accounting";
import { withCandidate } from "../candidate";
import { sameState } from "../caseList/details";
import { type Claim, defineClaims, take } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { canonicalExpression } from "../expressions/canonical";
import type { ComparedType } from "../expressions/comparedTypes";
import {
	holdsHqConvertedComparison,
	type SearchRowRuntimeClass,
	searchRowRuntimeClasses,
} from "../expressions/csqlRead";
import { core, flat, instanceId } from "../expressions/folds";
import { searchRowProperties } from "../expressions/scanReads";
import {
	emittedSearchConjuncts,
	matchSearchRows,
	readSearchRowConjuncts,
} from "../expressions/searchRows";
import type { SurfaceUse } from "../expressions/surfaceUses";
import { externalKey, mintEntityUuid } from "../identity";
import { isJsonObject, type JsonCursor, sameJson } from "../jsonCursor";
import { readProjectionInputs } from "../projectionInputs";
import { refusalDeferredAt } from "../provisional";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { joinReadsAlike } from "./joinReadsAlike";
import type { PromptReading } from "./prompts";
import { searchPlace } from "./workflow";

const S = "case-search/";

const INVENTORY = inventoryIndex();

/** The most simple-field readings of one menu whose combinations are tried against the stored
 *  order of its rows: the combinations double with each. */
const MAX_DERIVATIONS_RECONSIDERED = 8;

/** Nova's zero-input row as HQ JSON holds it. */
const ZERO_INPUT_ROW = hqXPathText(hqXPath(ZERO_INPUT_SEARCH_SENTINEL));

/** The entry the rows are held under, each top-level conjunct placed. */
export const ROWS_HELD = `${S}several-xpath-query-rows`;

/** The entry a menu with no prompt whose default filters are only HQ's two markers is held under. */
export const MARKERS_HELD = `${S}default-properties-entries-keyed-include-closed-or-x-commcare`;

export const ROW_CLAIMS = defineClaims("search.rows", {
	readsMatchedField: take(
		`${S}xpath-query-row-reading-a-field-hq-also-matches`,
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	readsExcludedField: take(
		`${S}xpath-query-row-reading-an-excluded-field-outside-its-presence-guard`,
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	noSlot: take(
		`${S}xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s`,
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	unrestated: take(
		`${S}case-list-filter-clause-the-search-does-not-restate`,
		"schema:Detail.filter",
	),
});

const ROW_VALUE = "schema:DefaultCaseSearchProperty.defaultValue";

/** A row chosen by a Search field's presence test (`if(count(<field>), …, 'match-all()')`):
 *  the class of the row's value, claimed as a part of it beside the row's own claim. */
const PRESENCE_CLAIMS = defineClaims("search.rows.presence", {
	presence: take(`${S}clause-chosen-at-runtime-by-input-presence`, ROW_VALUE),
});

/** The surface use a row's presence test makes (`surfaceUses.ts::csqlUses`), which the row's
 *  value holds, not its key. */
const PRESENCE_USE = "csql-key:_xpath_query";

/** A held row's comparison HQ's search runs by its own conversion of the value, which Nova's own
 *  rules would type otherwise (`csqlRead.ts::holdsHqConvertedComparison`): a part of the row's
 *  value claimed beside the row's own claim. */
const CONVERTED_CLAIMS = defineClaims("search.rows.converted", {
	converted: take(
		`${S}xpath-query-condition-outside-what-nova-types`,
		ROW_VALUE,
	),
});

/** What a held row works out on the device, each class a part of the row's value claimed beside
 *  the row's own claim (`csqlRead.ts::searchRowRuntimeClasses`). */
const RUNTIME_CLAIMS = defineClaims("search.rows.runtime", {
	"conditional-choice": take(
		`${S}clause-chosen-at-runtime-by-a-condition-over-session-worker`,
		ROW_VALUE,
	),
	"case-or-datum-terms": take(
		`${S}runtime-values-read-from-casedb-or-session-datums`,
		ROW_VALUE,
	),
	"first-lookup-cell": take(
		`${S}search-value-from-first-lookup-cell`,
		ROW_VALUE,
	),
	"session-context-drift-term": take(
		`${S}runtime-values-read-from-the-session-context-drift`,
		ROW_VALUE,
	),
	"session-context-window-width-term": take(
		`${S}runtime-values-read-from-the-session-context-window-width`,
		ROW_VALUE,
	),
	"session-context-applanguage-term": take(
		`${S}runtime-values-read-from-the-session-context-applanguage`,
		ROW_VALUE,
	),
} satisfies Record<SearchRowRuntimeClass, Claim<"take">>);

/** Where one top-level conjunct of one `_xpath_query` row was placed. */
export type ConjunctPlacement =
	| { readonly kind: "A" }
	/** `clause` is the index of the list filter's top-level conjunct it restates. */
	| { readonly kind: "B"; readonly clause: number }
	/** `input` is the simple Search field it derives, with the arm's slots as read. */
	| {
			readonly kind: "C";
			readonly input: Uuid;
			readonly property: string;
			readonly via?: RelationPath;
			readonly mode?: SearchInputMode;
	  }
	/** `input` is the advanced field whose condition it is, for `from: "field"` alone. */
	| {
			readonly kind: "D";
			readonly from: "field" | "filter";
			readonly input?: Uuid;
	  }
	| { readonly kind: "F" }
	/** `entry` is the id of the entry the conjunct raised. */
	| { readonly kind: "E"; readonly entry: string };

export interface RowClassification {
	/** One record per top-level conjunct, by source row and then by its place in the row. */
	readonly conjuncts: readonly {
		readonly row: number;
		readonly predicate: Expression;
		readonly placement: ConjunctPlacement;
	}[];
	/** Indexes of the list filter's top-level conjuncts no kind B conjunct restates. */
	readonly unrestated: readonly number[];
}

/** One `_xpath_query` row as the first pass kept it. */
export interface SearchRow {
	/** The row's index among `default_properties`. */
	readonly index: number;
	readonly text: string;
	/** The site of its `defaultValue`. */
	readonly cursor: import("../jsonCursor").JsonCursor;
}

/** What the classification reads of a menu's first pass. */
export interface RowsInput {
	readonly rows: readonly SearchRow[];
	readonly prompts: readonly PromptReading[];
	readonly formsReadSearch: boolean;
	/** The rows kind A placed in the first pass. */
	readonly zeroInput: boolean;
	/** Whether the menu's default filters are only HQ's two markers and it has no prompt: Nova's
	 *  search with no fields and no filter, which Nova writes as its zero-input row. */
	readonly markersOnly?: boolean;
}

function topLevel(expression: Expression | undefined): Expression[] {
	if (expression === undefined) return [];
	return expression.kind === "and" ? [...expression.clauses] : [expression];
}

/** Every Search field a tree reads, and whether each read sits under its own presence guard: a
 *  presence test reads its field too, whether the worker answered it (`presence`). */
function inputReads(
	expression: unknown,
): { uuid: Uuid; guarded: boolean; presence?: true }[] {
	const out: { uuid: Uuid; guarded: boolean; presence?: true }[] = [];
	const walk = (node: unknown, guards: ReadonlySet<string>): void => {
		if (Array.isArray(node)) {
			for (const one of node) walk(one, guards);
			return;
		}
		if (!isJsonObject(node)) return;
		if (node.kind === "when-input-present" && isJsonObject(node.input)) {
			// The presence test reads the field too: whether the worker answered it.
			const uuid = node.input.searchInputUuid as string;
			out.push({ uuid: uuid as Uuid, guarded: true, presence: true });
			walk(node.clause, new Set([...guards, uuid]));
			return;
		}
		if (node.kind === "input" && typeof node.searchInputUuid === "string") {
			out.push({
				uuid: node.searchInputUuid as Uuid,
				guarded: guards.has(node.searchInputUuid),
			});
			return;
		}
		for (const value of Object.values(node)) walk(value, guards);
	};
	walk(expression, new Set());
	return out;
}

/** Every `prop` reference of a tree: the candidates of a simple field's derivation. */
function propertyRefs(
	expression: unknown,
): { property: string; caseType?: string; via?: RelationPath }[] {
	const out: { property: string; caseType?: string; via?: RelationPath }[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const one of node) walk(one);
			return;
		}
		if (!isJsonObject(node)) return;
		if (node.kind === "prop" && typeof node.property === "string") {
			out.push({
				property: node.property,
				...(typeof node.caseType === "string" && { caseType: node.caseType }),
				...(node.via !== undefined && { via: node.via as RelationPath }),
			});
			return;
		}
		for (const value of Object.values(node)) walk(value);
	};
	walk(expression);
	return out;
}

/**
 * The `(property, via)` pairs a simple field's derivation can be, read from a conjunct: each `prop`
 * with the walk it names, and each `prop` with no walk of its own inside an `exists` over a
 * relation path, with that path. Every target first gives a related case's comparison one related
 * row (`normalizeRelationEvaluationScopes`), so a simple field over the case above binds back as
 * the presence of a case above whose own property compares, its path typed as the catalog types it.
 */
function derivationRefs(
	expression: unknown,
): { property: string; via?: RelationPath }[] {
	const out = propertyRefs(expression);
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const one of node) walk(one);
			return;
		}
		if (!isJsonObject(node)) return;
		if (
			node.kind === "exists" &&
			isRelationPath(node.via) &&
			node.via.kind !== "self"
		) {
			const via = node.via;
			for (const ref of propertyRefs(node.where))
				if (
					ref.via === undefined &&
					!out.some(
						(one) => one.property === ref.property && sameJson(one.via, via),
					)
				)
					out.push({ property: ref.property, via });
		}
		for (const value of Object.values(node)) walk(value);
	};
	walk(expression);
	return out;
}

const SCALAR_MODES: readonly (SearchInputMode | undefined)[] = [
	undefined,
	{ kind: "fuzzy" },
	{ kind: "starts-with" },
	{ kind: "phonetic" },
	{ kind: "fuzzy-date" },
	{ kind: "exact" },
];

/**
 * Whether a simple field's type admits the type the app's writers give the property it matches
 * (`SEARCH_INPUT_TYPE_PROPERTY_TYPES`, at the relation's destination, the table the gate refuses
 * Nova's own matching by): a condition a field of another type would derive to is Nova's
 * comparison of a value the property does not hold, so the field keeps its condition.
 */
function typeFitsProperty(
	doc: BlueprintDoc,
	caseType: string,
	candidate: SimpleSearchInputDef,
): boolean {
	const allowed = SEARCH_INPUT_TYPE_PROPERTY_TYPES[candidate.type];
	if (allowed === undefined) return true;
	const caseTypes = effectiveCaseTypes(doc);
	const destination = resolveRelationDestination(
		candidate.via,
		caseType,
		caseTypes,
	);
	if (!destination.ok) return true;
	const type = caseTypes
		.find((one) => one.name === destination.caseType)
		?.properties.find((one) => one.name === candidate.property)?.data_type;
	return type === undefined || allowed.includes(type);
}

/** The simple field whose derivation, in `doc`'s own types, is `conjunct`, for the visible field
 *  `input` it waits for; undefined where no property, path and mode derive it. The two trees are
 *  compared as the field's condition slot prints them (`canonicalExpression` there): a derivation
 *  over a related case's property prints as the presence of a related case whose property compares,
 *  which is how the row binds back. */
function derivedField(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	caseType: string,
	input: SearchInputDef,
	conjunct: Expression,
): SimpleSearchInputDef | undefined {
	if (
		conjunct.kind !== "when-input-present" ||
		conjunct.input.searchInputUuid !== input.uuid
	)
		return undefined;
	if (input.kind === "hidden") return undefined;
	// A field that lets the worker search for blank sends the blank beside its answer, which a
	// derived condition reads as part of the answer: Nova's gate holds no simple field matched
	// through a condition that searches for blank (`searchForBlankRefusal`), so the field keeps its
	// condition as it reads.
	if (input.allowBlank === true) return undefined;
	const context = moduleExpressionContexts(
		doc,
		moduleUuid,
	)({ slot: "case_list_filter" });
	const modes =
		input.type === "date-range" ? [{ kind: "range" } as const] : SCALAR_MODES;
	const { kind: _kind, ...rest } = input as SearchInputDef & {
		predicate?: unknown;
		property?: unknown;
	};
	const {
		predicate: _predicate,
		property: _property,
		via: _via,
		mode: _mode,
		...shared
	} = rest as Record<string, unknown>;
	let conditionContext: ExpressionContext | null | undefined;
	const printedAlike = (derived: Expression): boolean => {
		if (conditionContext === undefined)
			try {
				conditionContext = moduleExpressionContexts(
					doc,
					moduleUuid,
				)({
					slot: "search_input_predicate",
					member: { searchInputUuid: input.uuid },
				});
			} catch (error) {
				rethrowWorkStop(error);
				conditionContext = null;
			}
		if (conditionContext === null) return false;
		return sameJson(
			canonicalExpression(derived, conditionContext),
			canonicalExpression(conjunct, conditionContext),
		);
	};
	for (const ref of derivationRefs(conjunct.clause))
		for (const mode of modes) {
			const candidate = {
				...shared,
				kind: "simple",
				property: ref.property,
				...(ref.via !== undefined && { via: ref.via }),
				...(mode !== undefined && { mode }),
			} as SimpleSearchInputDef;
			if (!simpleArmNeedsXPathQueryEmission(candidate)) continue;
			if (!typeFitsProperty(doc, caseType, candidate)) continue;
			let derived: Expression;
			try {
				derived = deriveSimpleArmPredicate(candidate, caseType, context);
			} catch (error) {
				rethrowWorkStop(error);
				continue;
			}
			if (sameJson(derived, conjunct))
				return withTypedPath(doc, caseType, candidate);
			// A derivation over a related case's property binds back as the related row's presence.
			if (candidate.via !== undefined && printedAlike(derived))
				return withTypedPath(doc, caseType, candidate);
		}
	return undefined;
}

/** `field` with its path typed as the catalog resolves it from `caseType`
 *  (`normalizeRelationEvaluationScopes.ts::canonicalizeRelationPath`): each step names the type it
 *  reaches. Every target prints a simple field's derivation from the typed path, so a step that
 *  names its type and one that names none print one search. `field` as it is where the catalog
 *  resolves no type, which is the gate's to refuse. */
function withTypedPath(
	doc: BlueprintDoc,
	caseType: string,
	field: SimpleSearchInputDef,
): SimpleSearchInputDef {
	if (field.via === undefined || field.via.kind === "self") return field;
	try {
		const { via } = canonicalizeRelationPath(field.via, {
			caseTypes: effectiveCaseTypes(doc),
			currentCaseType: caseType,
		});
		return sameJson(via, field.via) ? field : { ...field, via };
	} catch (error) {
		rethrowWorkStop(error);
		return field;
	}
}

/**
 * The reader's canonical choice `search-field-paths-are-typed`: a simple Search field whose path
 * names the case type each step reaches, and the same field whose steps name none where the catalog
 * resolves each to that type. Both derive one search row (`simpleArmDerivation.ts` hands the path to
 * every target, which types it first, `normalizeRelationEvaluationScopes`), and the reader returns
 * the typed path: a row over a related case binds back as the presence of a related case, whose path
 * names the type it reaches.
 */
export function searchFieldPathsAreTyped(doc: BlueprintDoc): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const caseType = doc.modules[moduleUuid]?.caseType;
		if (caseType === undefined) continue;
		const inputs = out.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
		inputs.forEach((input, at) => {
			if (input.kind !== "simple") return;
			const typed = withTypedPath(out, caseType, input);
			if (typed === input) return;
			out = withCandidate(out, (draft) => {
				const held = draft.modules[moduleUuid]?.caseListConfig?.searchInputs;
				if (held !== undefined) held[at] = typed;
			});
		});
	}
	return out;
}

/**
 * The simple field an advanced Search field's condition is the derivation of, in the document's
 * own types: the two print one search, the field excluded beside the same row, which the reader
 * returns as the simple field. Undefined where the condition is no derivation.
 */
export function simpleFieldOfCondition(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	input: SearchInputDef,
): SimpleSearchInputDef | undefined {
	const caseType = doc.modules[moduleUuid]?.caseType;
	if (input.kind !== "advanced" || caseType === undefined) return undefined;
	return derivedField(doc, moduleUuid, caseType, input, input.predicate);
}

/**
 * The reader's canonical choice `derived-search-conditions-are-simple-fields`: an advanced Search
 * field whose condition is the derivation of a simple field, where the search writes its rows in
 * the same order either way, prints the search the simple field prints; the reader returns the
 * simple field.
 */
export function derivedConditionsAreSimpleFields(
	doc: BlueprintDoc,
): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		// One field turned simple can let an earlier one keep the order, so until none turns.
		let turned = true;
		while (turned) {
			turned = false;
			for (const input of out.modules[moduleUuid]?.caseListConfig
				?.searchInputs ?? []) {
				const simple = simpleFieldOfCondition(out, moduleUuid, input);
				if (simple === undefined) continue;
				const candidate = withCandidate(out, (draft) => {
					const inputs =
						draft.modules[moduleUuid]?.caseListConfig?.searchInputs;
					const at = inputs?.findIndex((one) => one.uuid === input.uuid) ?? -1;
					if (inputs !== undefined && at !== -1) inputs[at] = simple;
				});
				if (
					sameJson(
						emittedSearchConjuncts(candidate, moduleUuid),
						emittedSearchConjuncts(out, moduleUuid),
					)
				) {
					out = candidate;
					turned = true;
				}
			}
		}
	}
	return out;
}

/**
 * The reader's canonical choice `searches-that-find-nothing-as-read`: a search one of whose sources
 * (the case list filter, or an advanced Search field's condition) is never true sends HQ the one
 * row `match-none()` and none of its other conditions (`xpathQuery.ts::composeXPathQueryClauses`),
 * so every simple field it derives a row for reads as an advanced field, every advanced field's
 * condition as none, the list filter as the list's own filter a device reads prints it (its Search
 * fields unanswered, `deviceFilter`), and the search condition as `match-none`, whichever source
 * sent the row: it reads no field, so it is a condition on the whole search
 * (`classifySearchRows`, kind F), and the search condition is the list's where the two are one.
 */
export function searchesThatFindNothingAsRead(doc: BlueprintDoc): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const config = out.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const conjuncts = emittedSearchConjuncts(out, moduleUuid);
		const [only, ...more] = conjuncts;
		if (only?.kind !== "match-none" || more.length > 0) continue;
		// No row of the filter's is sent, so it prints only as a device reads
		// it, its Search fields unanswered.
		const device = deviceFilter(config.filter);
		const next = withCandidate(out, (draft) => {
			const list = draft.modules[moduleUuid]?.caseListConfig;
			const inputs = list?.searchInputs;
			if (list === undefined || inputs === undefined) return;
			// The one row reads no field, so it is the search condition's
			// (`classifySearchRows`, kind F), whichever source sent it; the list a
			// device runs keeps its own condition.
			replaceCaseConditions(list, {
				listCondition: device ?? null,
				searchCondition: { kind: "match-none" },
			});
			inputs.forEach((input, at) => {
				const excluded =
					input.kind === "advanced" ||
					(input.kind === "simple" && simpleArmNeedsXPathQueryEmission(input));
				if (!excluded) return;
				const {
					property: _property,
					via: _via,
					mode: _mode,
					predicate: _predicate,
					...rest
				} = input as SearchInputDef & {
					property?: unknown;
					via?: unknown;
					mode?: unknown;
					predicate?: unknown;
				};
				inputs[at] = {
					...rest,
					kind: "advanced",
					predicate: { kind: "match-all" },
				} as SearchInputDef;
			});
		});
		if (!sameJson(next, out)) out = next;
	}
	return out;
}

/**
 * The reader's canonical choice `search-filter-conditions-of-a-field-are-its-own`: a top-level
 * conjunct of a searched case list's filter that reads Search fields and prints no clause of the
 * list's own filter (a device reads no answer there,
 * `caseList.ts::projectCaseListFilter`; `waitsForFields`), prints the row the same conjunct prints
 * as the condition of the first field it reads, where that field is an advanced one and the
 * search's rows come out the same; the reader places such a row on that field
 * (`classifySearchRows`, kind D, whose first candidate is the field's own condition where it keeps
 * the rows in their order, or, where an earlier row read as the field's derivation, that
 * derivation as its condition again with the conjunct joined), ahead of the field's own rows,
 * since Nova writes the filter's rows first. It holds for every menu that offers a search, whether
 * or not the menu stores search settings, as the reader's placement does.
 */
export function filterConditionsOfAFieldAreItsOwn(
	doc: BlueprintDoc,
): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const module = out.modules[moduleUuid];
		const config = module?.caseListConfig;
		if (
			module === undefined ||
			config === undefined ||
			effectiveCaseSearchConfig(module) === undefined
		)
			continue;
		const [only, ...more] = emittedSearchConjuncts(out, moduleUuid);
		if (only?.kind === "match-none" && more.length === 0) continue;
		// Each clause moves on its own, ahead of the field's own conjuncts and after the clauses
		// moved there before it in the same pass, where the search's rows come out the same. A
		// clause moves only once every clause after it whose rows the list filter writes has moved,
		// since Nova writes the list filter's rows before every field's, so the passes repeat until
		// one moves nothing.
		let moving = true;
		while (moving) {
			moving = false;
			const filter = out.modules[moduleUuid]?.caseListConfig?.filter;
			const taken = new Map<Uuid, number>();
			for (const clause of topLevel(effectiveFilterForEmission(filter))) {
				const reads = inputReads(clause);
				const first = config.searchInputs.find((input) =>
					reads.some((read) => read.uuid === input.uuid),
				);
				if (
					reads.length === 0 ||
					first?.kind !== "advanced" ||
					!waitsForFields(clause)
				)
					continue;
				const at = taken.get(first.uuid) ?? 0;
				const moved = withCandidate(out, (draft) => {
					const list = draft.modules[moduleUuid]?.caseListConfig;
					if (list === undefined) return;
					const kept = topLevel(effectiveFilterForEmission(list.filter));
					const index = kept.findIndex((one) => sameJson(one, clause));
					if (index === -1) return;
					const [head, ...rest] = kept.filter((_, one) => one !== index);
					if (head === undefined) delete list.filter;
					else
						list.filter =
							rest.length === 0
								? head
								: { kind: "and", clauses: [head, ...rest] };
					const input = list.searchInputs.find(
						(one) => one.uuid === first.uuid,
					);
					if (input?.kind !== "advanced") return;
					const own = topLevel(effectiveFilterForEmission(input.predicate));
					const [lead, ...others] = [
						...own.slice(0, at),
						clause,
						...own.slice(at),
					];
					if (lead !== undefined)
						input.predicate =
							others.length === 0
								? lead
								: { kind: "and", clauses: [lead, ...others] };
				});
				if (
					!sameJson(
						moved.modules[moduleUuid]?.caseListConfig,
						out.modules[moduleUuid]?.caseListConfig,
					) &&
					sameJson(
						emittedSearchConjuncts(moved, moduleUuid),
						emittedSearchConjuncts(out, moduleUuid),
					)
				) {
					out = moved;
					taken.set(first.uuid, at + 1);
					moving = true;
				}
			}
		}
	}
	return out;
}

/**
 * The reader's canonical choice `search-field-conditions-of-another-field-are-its-own`: a conjunct
 * of an advanced Search field's condition that reads Search fields, the first of which (in the
 * fields' order) is another advanced field, and the same conjunct
 * as that field's condition's last conjunct, where the search's rows come out the same: Nova writes
 * one row per top-level conjunct of each field's condition, field after field, so both print one
 * export, and the reader returns the first field's (`classifySearchRows`, kind D, whose first
 * candidate is the condition of the first field the conjunct reads).
 */
export function fieldConditionsOfAnotherFieldAreItsOwn(
	doc: BlueprintDoc,
): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const module = out.modules[moduleUuid];
		const config = module?.caseListConfig;
		if (
			module === undefined ||
			config === undefined ||
			effectiveCaseSearchConfig(module) === undefined
		)
			continue;
		const [only, ...more] = emittedSearchConjuncts(out, moduleUuid);
		if (only?.kind === "match-none" && more.length === 0) continue;
		for (const field of config.searchInputs) {
			if (field.kind !== "advanced") continue;
			for (const clause of topLevel(
				effectiveFilterForEmission(field.predicate),
			)) {
				const reads = inputReads(clause);
				const first = config.searchInputs.find((input) =>
					reads.some((read) => read.uuid === input.uuid),
				);
				if (
					reads.length === 0 ||
					first?.kind !== "advanced" ||
					first.uuid === field.uuid
				)
					continue;
				const held = out.modules[moduleUuid]?.caseListConfig?.searchInputs.find(
					(one) => one.uuid === field.uuid,
				);
				if (
					held?.kind !== "advanced" ||
					!topLevel(held.predicate).some((one) => sameJson(one, clause))
				)
					continue;
				const moved = withCandidate(out, (draft) => {
					withoutPredicateClause(
						draft as BlueprintDoc,
						moduleUuid,
						field.uuid,
						clause,
					);
					setPredicate(draft as BlueprintDoc, moduleUuid, first.uuid, clause);
				});
				if (
					sameJson(
						emittedSearchConjuncts(moved, moduleUuid),
						emittedSearchConjuncts(out, moduleUuid),
					)
				)
					out = moved;
			}
		}
	}
	return out;
}

/**
 * The reader's canonical choice `search-field-conditions-over-other-fields-are-the-filter-s`: a
 * conjunct of an advanced Search field's condition that reads Search fields, the first of which (in
 * the fields' order) is no advanced field, and the same
 * conjunct as the searched case list filter's last clause, where the search's rows come out the
 * same and the conjunct prints nothing in the list's own filter, where a device reads no answer
 * (`caseList.ts::projectCaseListFilter`; `waitsForFields`): both print one export, and the
 * reader returns the list filter's
 * (`classifySearchRows`, kind D, which tries the list filter before another field's condition).
 */
export function fieldConditionsOverOtherFieldsAreTheFilters(
	doc: BlueprintDoc,
): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const module = out.modules[moduleUuid];
		const config = module?.caseListConfig;
		if (
			module === undefined ||
			config === undefined ||
			effectiveCaseSearchConfig(module) === undefined
		)
			continue;
		for (const field of config.searchInputs) {
			if (field.kind !== "advanced") continue;
			for (const clause of topLevel(
				effectiveFilterForEmission(field.predicate),
			)) {
				const reads = inputReads(clause);
				const first = config.searchInputs.find((input) =>
					reads.some((read) => read.uuid === input.uuid),
				);
				if (
					reads.length === 0 ||
					first === undefined ||
					first.kind === "advanced" ||
					!waitsForFields(clause)
				)
					continue;
				if (!topLevel(field.predicate).some((one) => sameJson(one, clause)))
					continue;
				const moved = withCandidate(out, (draft) => {
					withoutPredicateClause(
						draft as BlueprintDoc,
						moduleUuid,
						field.uuid,
						clause,
					);
					setFilter(draft as BlueprintDoc, moduleUuid, clause);
				});
				if (
					sameJson(
						emittedSearchConjuncts(moved, moduleUuid),
						emittedSearchConjuncts(out, moduleUuid),
					)
				)
					out = moved;
			}
		}
	}
	return out;
}

/**
 * The reader's canonical choice `search-field-conditions-reading-no-field-are-the-filter-s`: on a
 * menu whose forms read the search, and whose list no advanced form loads, a conjunct of an
 * advanced Search field's condition that reads no Search field, and the same conjunct as the list
 * filter's last clause, where the list's own filter a device reads prints the same with it joined
 * (`joinKeepsDeviceFilter`: a filter a device already reads as nothing) and the search's rows come
 * out the same: both print one export, and the reader returns the list filter's
 * (`classifySearchRows`, kind F, which tries the filter first where a device prints the same).
 */
export function fieldConditionsReadingNoFieldAreTheFilters(
	doc: BlueprintDoc,
): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const module = out.modules[moduleUuid];
		const config = module?.caseListConfig;
		if (
			module === undefined ||
			config === undefined ||
			!moduleFormsReadSearch(module) ||
			listLoadedByAdvancedForm(out, moduleUuid)
		)
			continue;
		for (const field of config.searchInputs) {
			if (field.kind !== "advanced") continue;
			for (const clause of topLevel(
				effectiveFilterForEmission(field.predicate),
			)) {
				if (
					inputReads(clause).length > 0 ||
					!topLevel(field.predicate).some((one) => sameJson(one, clause))
				)
					continue;
				const list = out.modules[moduleUuid]?.caseListConfig;
				if (!joinKeepsDeviceFilter(list?.filter, clause)) continue;
				const moved = withCandidate(out, (draft) => {
					withoutPredicateClause(
						draft as BlueprintDoc,
						moduleUuid,
						field.uuid,
						clause,
					);
					setFilter(draft as BlueprintDoc, moduleUuid, clause);
				});
				if (
					sameJson(
						emittedSearchConjuncts(moved, moduleUuid),
						emittedSearchConjuncts(out, moduleUuid),
					)
				)
					out = moved;
			}
		}
	}
	return out;
}

/**
 * The reader's canonical choice `search-field-conditions-reading-no-field-are-the-search-s`: a
 * top-level conjunct of an advanced Search field's condition that reads no Search field
 * (`searchConditions.ts::readsSearchField`), and the same conjunct as the search condition's last
 * clause, the field's condition all records where it held nothing else. Nova writes every field's
 * conjunct that reads no field with the search condition's rows, ahead of every field's
 * (`xpathQuery.ts::composeXPathQueryClauses`), so both print one request, and the reader returns
 * the search condition's (`classifySearchRows`, kind F): such a conjunct is a condition on the whole
 * search, which an author sees there. The list a device runs keeps its own condition. A move is
 * taken only where the search's rows come out the same.
 */
export function fieldConditionsReadingNoFieldAreTheSearchs(
	doc: BlueprintDoc,
): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const module = out.modules[moduleUuid];
		const config = module?.caseListConfig;
		if (
			module === undefined ||
			config === undefined ||
			effectiveCaseSearchConfig(module) === undefined
		)
			continue;
		const [only, ...more] = emittedSearchConjuncts(out, moduleUuid);
		if (only?.kind === "match-none" && more.length === 0) continue;
		const moved = withCandidate(out, (draft) => {
			const list = draft.modules[moduleUuid]?.caseListConfig;
			if (list === undefined) return;
			let search = searchConditionOf(list);
			for (const input of list.searchInputs) {
				if (input.kind !== "advanced") continue;
				const own = topLevel(effectiveFilterForEmission(input.predicate));
				const wide = own.filter((clause) => !readsSearchField(clause));
				if (wide.length === 0) continue;
				for (const clause of wide) search = joinedFilter(search, clause);
				const [head, ...rest] = own.filter((clause) =>
					readsSearchField(clause),
				);
				input.predicate =
					head === undefined
						? { kind: "match-all" }
						: rest.length === 0
							? head
							: { kind: "and", clauses: [head, ...rest] };
			}
			if (search !== undefined)
				replaceCaseConditions(list, { searchCondition: search });
		});
		if (
			!sameJson(
				moved.modules[moduleUuid]?.caseListConfig,
				out.modules[moduleUuid]?.caseListConfig,
			) &&
			sameJson(
				emittedSearchConjuncts(moved, moduleUuid),
				emittedSearchConjuncts(out, moduleUuid),
			)
		)
			out = moved;
	}
	return out;
}

/** `filter` with `clause` joined as its last top-level conjunct, as `setFilter` joins it. */
function joinedFilter(
	filter: Expression | undefined,
	clause: Expression,
): Expression {
	return filter === undefined || filter.kind === "match-all"
		? clause
		: {
				kind: "and",
				clauses: [...topLevel(filter), clause] as unknown as [
					Expression,
					...Expression[],
				],
			};
}

/** Whether a list filter with `clause` joined prints, in the list's own filter a device reads
 *  (`caseList.ts::projectCaseListFilter`, which drops a clause whose fields are unanswered and
 *  simplifies the rest), what `filter` prints there. */
function joinKeepsDeviceFilter(
	filter: Expression | undefined,
	clause: Expression,
): boolean {
	return sameJson(
		deviceFilter(filter),
		deviceFilter(joinedFilter(filter, clause)),
	);
}

/** What a list filter prints in the list's own filter a device reads
 *  (`caseList.ts::projectCaseListFilter`): its Search fields unanswered and
 *  the rest simplified, or nothing. */
function deviceFilter(filter: Expression | undefined): Expression | undefined {
	return filter === undefined
		? undefined
		: effectiveFilterForEmission(substituteUnansweredSearchInputs(filter));
}

/** Whether a searched list filter's clause waits for its Search fields: it prints nothing in the
 *  list's own filter a device reads (`deviceFilter`), so the search's row alone carries it, and it
 *  prints the row an advanced field's condition holding it prints. The one test of where such a
 *  clause may stand: the reader places a row on the list filter as such a clause
 *  (`classifySearchRows`, kind D) only where it holds, and the canonical rows that move a clause
 *  between the list filter and a field's condition move only one it holds for. A clause a device
 *  prints (a field's presence test under a negation, which reads as never there) is a clause of
 *  the list the case list stage reads, which a row restates (kind B). */
function waitsForFields(clause: Expression): boolean {
	return deviceFilter(clause) === undefined;
}

/** Whether the module's list filter type-checks in its own slot: a filter both the list and the
 *  search read takes a device's rules as well as HQ's, so a comparison only HQ's search runs by
 *  converting its value (`searchIndexedComparison`) stays the search condition's alone. */
function typesAsListFilter(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	naming: ReturnType<typeof readProjectionInputs>["lookupNaming"],
): boolean {
	const filter = doc.modules[moduleUuid]?.caseListConfig?.filter;
	if (filter === undefined) return true;
	try {
		const context = moduleExpressionContexts(
			doc,
			moduleUuid,
			naming,
		)({ slot: "case_list_filter" });
		return checkExpression(filter, context).errors.length === 0;
	} catch (error) {
		rethrowWorkStop(error);
		return false;
	}
}

/** Whether an advanced form loads a case from `moduleUuid`'s list. */
function listLoadedByAdvancedForm(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	return Object.keys(doc.forms).some((formUuid) =>
		advancedFormLoads(doc, formUuid as Uuid).some(
			(load) => load.listModule === moduleUuid,
		),
	);
}

/** The simple arm a conjunct derives for an excluded prompt, the first candidate whose derivation
 *  is the conjunct; a date field over a property typed `date`, then `datetime`, each property typed
 *  on the case type it belongs to (`refCaseType`). */
export function simpleDerivation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	caseType: string,
	prompt: PromptReading,
	conjunct: Expression,
):
	| {
			property: string;
			via?: RelationPath;
			mode?: SearchInputMode;
			doc: BlueprintDoc;
	  }
	| undefined {
	const docs: BlueprintDoc[] = [doc];
	if (prompt.type === "date" || prompt.type === "date-range")
		for (const dataType of ["date", "datetime"] as const)
			docs.push(
				withCandidate(doc, (draft) => {
					// Each property is typed on the case type it belongs to: the menu's own, a related
					// case's where the read names one (a property inside an `exists` over the case above),
					// or the type a walk of its own reaches.
					for (const ref of propertyRefs(conjunct)) {
						const owner = refCaseType(doc, caseType, ref);
						const property = draft.caseTypes
							?.find((one) => one.name === owner)
							?.properties.find((one) => one.name === ref.property);
						if (property !== undefined) property.data_type = dataType;
					}
				}),
			);
	for (const candidateDoc of docs) {
		const field = derivedField(
			candidateDoc,
			moduleUuid,
			caseType,
			prompt.input,
			conjunct,
		);
		if (field !== undefined)
			return {
				property: field.property,
				...(field.via !== undefined && { via: field.via }),
				...(field.mode !== undefined && { mode: field.mode }),
				doc: candidateDoc,
			};
	}
	return undefined;
}

/** The case type a property read belongs to: the type a walk of its own reaches from the type it
 *  names (or the menu's), else the type it names, else the menu's; undefined where the walk reaches
 *  no one type. */
function refCaseType(
	doc: BlueprintDoc,
	caseType: string,
	ref: { caseType?: string; via?: RelationPath },
): string | undefined {
	const origin = ref.caseType ?? caseType;
	if (ref.via === undefined) return origin;
	try {
		return canonicalizeRelationPath(ref.via, {
			caseTypes: effectiveCaseTypes(doc),
			currentCaseType: origin,
		}).destinationCaseType;
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

/** A type a date Search field's derivation gives a property no writer types. */
export interface DateFieldDeclaration {
	readonly property: string;
	readonly dataType: "date" | "datetime";
}

/**
 * The types the menu's excluded date and date range fields give the properties their rows read and
 * `doc` leaves untyped, worked out before any expression binds: such a row reads back as the
 * field's derivation only over a typed property, so each untyped property it reads is tried as
 * `date`, then `datetime`, as `simpleDerivation` tries them, and the first type under which a
 * conjunct of the row is the field's derivation is the property's. A row that reads as no
 * derivation under either declares nothing.
 */
export function dateFieldDeclarations(
	ctx: ReadContext,
	doc: BlueprintDoc,
	module: DraftModule,
	input: RowsInput,
): DateFieldDeclaration[] {
	const caseType = doc.modules[module.uuid]?.caseType;
	const out: DateFieldDeclaration[] = [];
	if (caseType === undefined || input.zeroInput) return out;
	const typed = new Set(
		(
			effectiveCaseTypes(doc).find((type) => type.name === caseType)
				?.properties ?? []
		).flatMap((property) =>
			property.data_type === undefined ? [] : [property.name],
		),
	);
	const naming = readProjectionInputs(ctx).lookupNaming;
	const lookup = ctx.input.lookup.definitions;
	for (const prompt of input.prompts) {
		if (
			!prompt.exclude ||
			(prompt.type !== "date" && prompt.type !== "date-range")
		)
			continue;
		for (const row of input.rows) {
			const untyped = searchRowProperties(row.text).filter(
				(name) => !typed.has(name) && !out.some((one) => one.property === name),
			);
			if (untyped.length === 0) continue;
			for (const dataType of ["date", "datetime"] as const) {
				const candidate = withCandidate(doc, (draft) => {
					const type = draft.caseTypes?.find((one) => one.name === caseType);
					for (const name of untyped) {
						const property = type?.properties.find((one) => one.name === name);
						if (property !== undefined) property.data_type = dataType;
					}
				});
				const context = moduleExpressionContexts(
					candidate,
					module.uuid,
					naming,
				)({ slot: "case_list_filter" });
				const read = readSearchRowConjuncts(row.text, context, {
					doc: candidate,
					lookup,
				});
				// A field over a related case types a property of that case, which this menu's
				// case type does not hold.
				const derived = read.ok
					? read.conjuncts.find((conjunct) => {
							const field = derivedField(
								candidate,
								module.uuid,
								caseType,
								prompt.input,
								conjunct,
							);
							return field !== undefined && field.via === undefined;
						})
					: undefined;
				if (derived === undefined) continue;
				for (const ref of propertyRefs(derived))
					if (
						ref.via === undefined &&
						untyped.includes(ref.property) &&
						!out.some((one) => one.property === ref.property)
					)
						out.push({ property: ref.property, dataType });
				break;
			}
		}
	}
	return out;
}

/**
 * What the menu's rows read that the document must hold before any expression binds, each row
 * read in the case list filter's slot, else in the slot of the first excluded advanced field that
 * admits it, as the classification reads it:
 *
 * - `types`: the types the rows' comparisons give the properties `doc` leaves untyped. A row
 *   compares a property with a value of its own type, and Nova prints the comparison by that type
 *   (a date and time's equality as the moment's two bounds), so the row reads back only over a
 *   catalog that holds it (`expressions/csqlRead.ts::readSearchFilterRow`, which reads under them
 *   and reports them).
 * - `userFields`: each name of the worker's own data a row reads that CommCare HQ does not write
 *   on every worker's case itself, as the expression stage lists a slot's
 *   (`expressions/index.ts::readExpressions`). A row binds at the settle, after the worker
 *   properties are minted from the expression stage's reads, so it names its own; a property
 *   minted for it reads the row back as a read of that property. The checker refuses a session
 *   read of a name no worker property declares (`undeclared-worker-field`), which is every such
 *   read before the properties are minted, so a row refused for that alone is read again over
 *   `doc` holding a worker property for each name it reads of the session's worker data
 *   (`withSessionUserFields`), and names those its reading binds. `sessionUserFields` are those
 *   read from the session and not the worker's own case.
 */
export function rowEarlyReads(
	ctx: ReadContext,
	doc: BlueprintDoc,
	module: DraftModule,
	input: RowsInput,
): {
	types: ComparedType[];
	userFields: string[];
	sessionUserFields: string[];
} {
	const out: ComparedType[] = [];
	const userFields: string[] = [];
	const sessionUserFields: string[] = [];
	if (input.zeroInput || doc.modules[module.uuid] === undefined)
		return { types: out, userFields, sessionUserFields };
	const naming = readProjectionInputs(ctx).lookupNaming;
	const readRow = (over: BlueprintDoc, text: string) => {
		const env = { doc: over, lookup: ctx.input.lookup.definitions };
		const contexts = moduleExpressionContexts(over, module.uuid, naming);
		let undeclared = false;
		const attempt = (context: ExpressionContext) => {
			const one = readSearchRowConjuncts(text, context, env);
			if (
				!one.ok &&
				"claim" in one &&
				one.claim.detail.reason === "undeclared-worker-field"
			)
				undeclared = true;
			return one;
		};
		let read = attempt(contexts({ slot: "case_list_filter" }));
		if (!read.ok)
			for (const prompt of input.prompts) {
				const own = fieldConditionContext(contexts, prompt, new Set());
				if (own === undefined) continue;
				const again = attempt(own);
				if (!again.ok) continue;
				read = again;
				break;
			}
		return { read, undeclared };
	};
	for (const row of input.rows) {
		let over = doc;
		let { read, undeclared } = readRow(doc, row.text);
		if (!read.ok && undeclared) {
			over = withSessionUserFields(doc, sessionUserDataNames(row.text));
			({ read } = readRow(over, row.text));
		}
		if (!read.ok) continue;
		out.push(...read.types);
		const scratch = over.userProperties ?? NO_ENTRIES;
		for (const conjunct of read.conjuncts)
			walkExpressionTerms(conjunct, (term) => {
				// A field CommCare HQ writes on every worker's own case
				// (`callcenter/sync_usercase.py::_get_user_case_fields`) is no
				// worker property: the read stays the name-backed leaf.
				const field =
					term.kind === "session-user"
						? term.source === "worker-record" &&
							USERCASE_BUILT_IN_KEYS.includes(term.field)
							? undefined
							: term.field
						: term.kind === "session-user-property" &&
								doc.userProperties?.[term.userPropertyUuid] === undefined
							? scratch[term.userPropertyUuid]?.slug
							: undefined;
				if (field === undefined) return;
				if (!userFields.includes(field)) userFields.push(field);
				if (
					(term.kind === "session-user" ||
						term.kind === "session-user-property") &&
					term.source !== "worker-record" &&
					!sessionUserFields.includes(field)
				)
					sessionUserFields.push(field);
			});
	}
	return { types: out, userFields, sessionUserFields };
}

/**
 * Each name a row's text reads of the session's worker data,
 * `instance('commcaresession')/session/user/data/<name>`, from its syntax alone and in the
 * order it reads them: the names `rowEarlyReads` gives a worker property to read the row again
 * over, before its reading binds them.
 */
function sessionUserDataNames(text: string): string[] {
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch (error) {
		rethrowWorkStop(error);
		return [];
	}
	if (!read.ok || read.node === undefined) return [];
	const found: string[] = [];
	const visit = (node: FormSyntax, partOfPath: boolean): void => {
		const at = core(node);
		const path = partOfPath ? undefined : flat(at);
		const [session, user, data, name, ...rest] = path?.steps ?? [];
		if (
			instanceId(path) === "commcaresession" &&
			rest.length === 0 &&
			[session, user, data].every(
				(step, index) =>
					step !== undefined &&
					!step.attribute &&
					step.where.length === 0 &&
					step.name === ["session", "user", "data"][index],
			) &&
			name !== undefined &&
			!name.attribute &&
			name.where.length === 0 &&
			!found.includes(name.name)
		)
			found.push(name.name);
		switch (at.kind) {
			case "negative":
				visit(at.value, false);
				return;
			case "axis":
				visit(at.value, true);
				return;
			case "child":
				if (at.left !== undefined) visit(at.left, true);
				visit(at.step, true);
				return;
			case "filter":
				visit(at.base, true);
				visit(at.where, false);
				return;
			case "binary":
				visit(at.left, false);
				visit(at.right, false);
				return;
			case "call":
				for (const arg of at.args) visit(arg, false);
				return;
			default:
				return;
		}
	};
	visit(read.node, false);
	return found;
}

/**
 * `doc` holding a worker property for each of `names` it declares no worker property for: a
 * document a row is read over only to learn which of the names its reading binds, never one
 * a reading returns. Each property takes the UUID a first reading of the app mints for its slug
 * (`identity.ts::mintEntityUuid`), which no other kind of entity takes.
 */
function withSessionUserFields(
	doc: BlueprintDoc,
	names: readonly string[],
): BlueprintDoc {
	const declared = new Set(
		Object.values(doc.userProperties ?? {}).map((one) => one.slug),
	);
	const adding = names.filter((name) => !declared.has(name));
	if (adding.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		const properties = draft.userProperties ?? recordFromEntries([]);
		const order = draft.userPropertyOrder ?? [];
		for (const slug of adding) {
			const uuid = mintEntityUuid(doc.appId, externalKey.userProperty(slug));
			properties[uuid] = { uuid, slug, label: slug };
			order.push(uuid);
		}
		draft.userProperties = properties;
		draft.userPropertyOrder = order;
	});
}

/** Whether an advanced form of the app names the menu as its load's `details_module`. */
function loadNamesMenu(ctx: ReadContext, module: DraftModule): boolean {
	for (const other of ctx.draft.modules)
		for (const form of other.forms) {
			if (form.docType !== "AdvancedForm") continue;
			const actions = form.json.peek("actions");
			const loads = isJsonObject(actions)
				? actions.load_update_cases
				: undefined;
			if (
				Array.isArray(loads) &&
				loads.some(
					(load) =>
						isJsonObject(load) && load.details_module === module.uniqueId,
				)
			)
				return true;
		}
	return false;
}

/** The slot context of an excluded field's own condition, where the field can still take one:
 *  an advanced field not read as a simple field's derivation. */
function fieldConditionContext(
	contexts: ModuleExpressionContexts,
	prompt: PromptReading,
	derivedInputs: ReadonlySet<Uuid>,
): ExpressionContext | undefined {
	if (
		!prompt.exclude ||
		prompt.input.kind !== "advanced" ||
		derivedInputs.has(prompt.uuid)
	)
		return undefined;
	try {
		return contexts({
			slot: "search_input_predicate",
			member: { searchInputUuid: prompt.uuid },
		});
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

/** The case list filter Nova's projection of the menu writes, as HQ JSON holds it; `""` for none,
 *  undefined where the projection does not write the menu. */
function listFilterText(
	ctx: ReadContext,
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): string | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return undefined;
	const inputs = readProjectionInputs(ctx);
	try {
		const filter = projectCaseListForHq(
			mod,
			doc,
			inputs.assets,
			inputs.lookupNaming,
		).caseDetails.short.filter;
		return filter instanceof HqXPath
			? hqXPathText(filter)
			: typeof filter === "string"
				? filter
				: "";
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

/** `clause` with each date-and-time literal written as `other` writes a literal naming the same
 *  moment: a device's comparison folds a literal to its moment, and a search row keeps the text. */
function withInstantSpellings(
	clause: Expression,
	other: Expression,
): Expression {
	const spellings = new Map<number, string>();
	mapExpressionAst(other, {
		mapTerm: (term) => {
			if (term.kind === "literal" && typeof term.value === "string") {
				const micros = literalInstantMicros(term.value);
				if (micros !== undefined && !spellings.has(micros))
					spellings.set(micros, term.value);
			}
			return undefined;
		},
	});
	return mapExpressionAst(clause, {
		mapTerm: (term) => {
			if (term.kind !== "literal" || typeof term.value !== "string")
				return undefined;
			const micros = literalInstantMicros(term.value);
			const spelling = micros === undefined ? undefined : spellings.get(micros);
			return spelling === undefined || spelling === term.value
				? undefined
				: { ...term, value: spelling };
		},
	});
}

/** The mirror of each comparison kind: the same test with its sides swapped. */
const MIRRORED: SourceTable<Expression["kind"]> = tableOf({
	eq: "eq",
	neq: "neq",
	gt: "lt",
	gte: "lte",
	lt: "gt",
	lte: "gte",
});

/** `clause` with each comparison `other` holds with its sides swapped written as `other` writes it:
 *  a search row writes a comparison with the case's property on its left
 *  (`csql/representability.ts::normalizeCsqlPredicate`), which a device prints as the list filter
 *  holds it. */
function withOrientationOf(clause: Expression, other: Expression): Expression {
	const held: Expression[] = [];
	walkExpressionNodes(other, (node) => {
		if (MIRRORED.has(node.kind)) held.push(node);
	});
	const holds = (node: Expression) => held.some((one) => sameJson(one, node));
	return mapExpressionAst(clause, {
		mapExpression: (node) => {
			const kind = MIRRORED.get(node.kind);
			if (kind === undefined || !("left" in node) || !("right" in node))
				return undefined;
			const mirrored = {
				kind,
				left: node.right,
				right: node.left,
			} as Expression;
			return holds(mirrored) && !holds(node) ? mirrored : undefined;
		},
	});
}

/** `doc` with the run `run` of consecutive top-level clauses of the list filter replaced by the one
 *  clause `respelled`; undefined where the filter holds no such run. */
function withListClauses(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	run: readonly Expression[],
	respelled: Expression,
): BlueprintDoc | undefined {
	const filter = doc.modules[moduleUuid]?.caseListConfig?.filter;
	if (filter === undefined || run.length === 0) return undefined;
	const clauses = topLevel(filter);
	const at = clauses.findIndex((_, start) =>
		run.every((one, offset) => {
			const held = clauses[start + offset];
			return held !== undefined && sameJson(held, one);
		}),
	);
	if (at === -1) return undefined;
	const next = [
		...clauses.slice(0, at),
		respelled,
		...clauses.slice(at + run.length),
	];
	return withCandidate(doc, (draft) => {
		const config = draft.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) return;
		config.filter =
			next.length === 1
				? respelled
				: {
						kind: "and",
						clauses: next as unknown as [Expression, ...Expression[]],
					};
	});
}

/** Two clauses, a lower bound's comparison then an upper bound's of one operand, as the range
 *  they make; undefined for any other run. */
function rangeOfClauses(
	run: readonly Expression[],
): Extract<Expression, { kind: "between" }> | undefined {
	const [lower, upper, ...more] = run;
	if (
		more.length > 0 ||
		(lower?.kind !== "gte" && lower?.kind !== "gt") ||
		(upper?.kind !== "lte" && upper?.kind !== "lt") ||
		!sameJson(lower.left, upper.left)
	)
		return undefined;
	return {
		kind: "between",
		left: lower.left,
		lower: lower.right,
		upper: upper.right,
		lowerInclusive: lower.kind === "gte",
		upperInclusive: upper.kind === "lte",
	};
}

/** The first run of at least two consecutive clauses, of `count`, each `open`, that `restates`
 *  answers a document for, with that document; undefined where none does. */
function restatedRun(
	count: number,
	open: (index: number) => boolean,
	restates: (start: number, end: number) => BlueprintDoc | undefined,
): { start: number; end: number; doc: BlueprintDoc } | undefined {
	for (let start = 0; start < count; start++)
		for (let end = start + 2; end <= count && open(end - 1); end++) {
			if (!open(start)) break;
			const doc = restates(start, end);
			if (doc !== undefined) return { start, end, doc };
		}
	return undefined;
}

/** The gate's rules for what a device runs in a menu's case list: a match only HQ's search
 *  makes, a read a device's evaluator cannot unpack, date arithmetic the device cannot do. */
const DEVICE_LIST_RULES = [
	matchModeOnDeviceCompatibility,
	onDeviceExpressionCompatibility,
	dateAddOnDeviceCompatibility,
] as const;

/** Whether the gate's device rules refuse nothing more of `candidate`'s menu than of `before`'s:
 *  a list filter that gains a clause the device cannot run is no list filter Nova holds. */
function deviceRunsList(
	before: BlueprintDoc,
	candidate: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	const refusals = (doc: BlueprintDoc): number => {
		const mod = doc.modules[moduleUuid];
		return mod === undefined
			? 0
			: DEVICE_LIST_RULES.reduce(
					(count, rule) => count + rule(mod, moduleUuid, doc).length,
					0,
				);
	};
	return refusals(candidate) <= refusals(before);
}

function setFilter(
	draft: BlueprintDoc,
	moduleUuid: Uuid,
	clause: Expression,
): void {
	const config = draft.modules[moduleUuid]?.caseListConfig;
	if (config === undefined) return;
	config.filter = joinedFilter(config.filter, clause);
}

function setPredicate(
	draft: BlueprintDoc,
	moduleUuid: Uuid,
	input: Uuid,
	clause: Expression,
): void {
	const entry = draft.modules[moduleUuid]?.caseListConfig?.searchInputs.find(
		(one) => one.uuid === input,
	);
	if (entry === undefined || entry.kind !== "advanced") return;
	entry.predicate =
		entry.predicate.kind === "match-all"
			? clause
			: {
					kind: "and",
					clauses: [...topLevel(entry.predicate), clause] as unknown as [
						Expression,
						...Expression[],
					],
				};
}

/** `clause` among the list filter's top-level clauses, before `before` where the filter holds it,
 *  else last. */
function insertFilterClause(
	draft: BlueprintDoc,
	moduleUuid: Uuid,
	clause: Expression,
	before: Expression | undefined,
): void {
	const config = draft.modules[moduleUuid]?.caseListConfig;
	if (config === undefined) return;
	const clauses =
		config.filter === undefined || config.filter.kind === "match-all"
			? []
			: topLevel(config.filter);
	const at =
		before === undefined
			? -1
			: clauses.findIndex((one) => sameJson(one, before));
	const next =
		at === -1
			? [...clauses, clause]
			: [...clauses.slice(0, at), clause, ...clauses.slice(at)];
	config.filter =
		next.length === 1
			? (next[0] as Expression)
			: { kind: "and", clauses: next as [Expression, ...Expression[]] };
}

/** A simple field read as a derivation, turned back into the excluded field whose condition is
 *  no row of its own. */
function asExcludedField(
	draft: BlueprintDoc,
	moduleUuid: Uuid,
	input: Uuid,
): void {
	const inputs = draft.modules[moduleUuid]?.caseListConfig?.searchInputs;
	const at = inputs?.findIndex((one) => one.uuid === input) ?? -1;
	const entry = inputs?.[at];
	if (inputs === undefined || entry?.kind !== "simple") return;
	const {
		property: _property,
		via: _via,
		mode: _mode,
		...rest
	} = entry as SimpleSearchInputDef;
	inputs[at] = {
		...rest,
		kind: "advanced",
		predicate: { kind: "match-all" },
	} as SearchInputDef;
}

/** Takes `clause` back out of an advanced field's condition, which `setPredicate` added it to. */
function withoutPredicateClause(
	draft: BlueprintDoc,
	moduleUuid: Uuid,
	input: Uuid,
	clause: Expression,
): void {
	const entry = draft.modules[moduleUuid]?.caseListConfig?.searchInputs.find(
		(one) => one.uuid === input,
	);
	if (entry === undefined || entry.kind !== "advanced") return;
	const clauses = topLevel(entry.predicate);
	const at = clauses.findIndex((one) => sameJson(one, clause));
	if (at === -1) return;
	const rest = clauses.filter((_, index) => index !== at);
	entry.predicate =
		rest.length === 0
			? { kind: "match-all" }
			: rest.length === 1
				? (rest[0] as Expression)
				: { kind: "and", clauses: rest as [Expression, ...Expression[]] };
}

/**
 * Classifies every conjunct of the menu's rows, writes each placement into the document
 * (`ctx.doc`), runs the two closing checks and the comparison of the menu's rows, and returns
 * where each conjunct went.
 */
/**
 * Claims the uses a row's CSQL makes at the row's value, each key under every
 * class the row's texts use it in (`claimEntryClass` for each after the
 * first) but a key `claimed` already holds there; the use the row's presence
 * test makes is the row's value's own class (`PRESENCE_CLAIMS`).
 */
function claimRowUses(
	ctx: ReadContext,
	row: JsonCursor,
	uses: readonly SurfaceUse[],
	claimed: Set<string>,
	place: HqPlace,
): void {
	const site = { json: row, key: "defaultValue" };
	const detail = { name: "_xpath_query" };
	const first = new Set<string>();
	for (const use of uses) {
		if (use.key === PRESENCE_USE) {
			row.takePart("defaultValue", "presence", PRESENCE_CLAIMS.presence);
			continue;
		}
		if (claimed.has(use.key) && !first.has(use.key)) continue;
		if (first.has(use.key))
			ctx.accounting.claimEntryClass(site, use.entryId, use.key, place, detail);
		else {
			first.add(use.key);
			claimed.add(use.key);
			ctx.accounting.claimEntry(site, use.entryId, use.key, place, detail);
		}
	}
}

/**
 * `Accounting.claimEntry` of a row's refusal at the row: under `key` where the refusing entry
 * names it, and with no key where it names only the keys of the CSQL a row's text makes (an
 * operator, a function, a case's own date), which the row's uses then claim (`claimRowUses`).
 */
function claimRowKey(
	ctx: ReadContext,
	site: ClaimSite,
	entryId: string,
	key: string,
	place: HqPlace,
	detail: FindingDetail,
): void {
	const named = INVENTORY.entry(entryId)?.surfaceKeys.includes(key) === true;
	ctx.accounting.claimEntry(
		site,
		entryId,
		key,
		place,
		detail,
		named ? undefined : { keyless: true },
	);
}

/** The detail's own expression and its intact scope are established before search
 * rows settle. Record the different request at the same detail source pointer. */
function takeUnrestatedDetail(ctx: ReadContext, module: DraftModule): void {
	for (const index of ctx.pending.of("module", module.uuid)) {
		const registration = ctx.pending.list()[index];
		if (
			registration?.key !== "schema:Detail.filter" ||
			registration.ref.slot !== "case_list_filter"
		)
			continue;
		const { at } = ctx.pending.site(index);
		if ("json" in at)
			at.json.takePart(at.key, "independent-search", ROW_CLAIMS.unrestated);
	}
}

export function classifySearchRows(
	ctx: ReadContext,
	module: DraftModule,
	input: RowsInput,
): RowClassification {
	const conjuncts: {
		row: number;
		predicate: Expression;
		placement: ConjunctPlacement;
	}[] = [];
	const place = searchPlace(module);
	const start = ctx.doc;
	const mod = start?.modules[module.uuid];
	if (start === undefined || mod === undefined || mod.caseType === undefined)
		return { conjuncts, unrestated: [] };
	const caseType = mod.caseType;
	const listClauses = topLevel(
		effectiveFilterForEmission(mod.caseListConfig?.filter),
	);
	const restated = new Set<number>();
	const env = { doc: start, lookup: ctx.input.lookup.definitions };
	const sourceRows = input.rows.map((row) => row.text);
	const naming = readProjectionInputs(ctx).lookupNaming;
	let doc = start;
	const derivedInputs = new Set<Uuid>();
	// The advanced fields a placed conjunct has made a condition of.
	const conditioned = new Set<Uuid>();
	const ownsFilter = input.formsReadSearch && !loadNamesMenu(ctx, module);
	// Whether a row could not be read: a list clause it restates is then not known to go unrestated.
	let unread = false;
	// Whether the search's own filter joined to the list is declared.
	// Each conjunct read as a simple field's derivation, with its record's place.
	const derivations: { input: Uuid; conjunct: Expression; at: number }[] = [];
	// Each conjunct read as a field's own condition where the list filter could also take it,
	// with its record's place.
	const fieldConditions: { input: Uuid; conjunct: Expression; at: number }[] =
		[];

	if (input.zeroInput) {
		for (const row of input.rows)
			conjuncts.push({
				row: row.index,
				predicate: { kind: "match-all" },
				placement: { kind: "A" },
			});
		if (listClauses.length === 0) return { conjuncts, unrestated: [] };
		// Nova writes its zero-input row only for a search no list filter narrows
		// (`xpathQuery.ts::xpathQueryRequestValues`): beside a filter it sends the filter's clauses,
		// where the source's search finds every case of the type and HQ applies the filter to the
		// device's list alone (`remote_requests.py::_build_datum_nodeset`). No clause is restated.
		const unrestated = listClauses.map((_, index) => index);
		ctx.doc = withCandidate(doc, (draft) => {
			const config = draft.modules[module.uuid]?.caseListConfig;
			if (config) replaceCaseConditions(config, { searchCondition: null });
		});
		takeUnrestatedDetail(ctx, module);
		return { conjuncts, unrestated };
	}
	// The fields some row reads: a row that reads a field is that field's (its derivation or its own
	// condition), so a conjunct that reads no field is a holder's that no row reads first.
	const readByRows = new Set<Uuid>();
	// The fields some row derives as a simple field (kind C), whose condition a row that only reads
	// such a field is not: a simple field holds no condition.
	const derivable = new Set<Uuid>();
	{
		const contexts = moduleExpressionContexts(doc, module.uuid, naming);
		for (const row of input.rows) {
			const read = readSearchRowConjuncts(
				row.text,
				contexts({ slot: "case_search_filter" }),
				{ ...env, doc },
			);
			if (read.ok)
				for (const conjunct of read.conjuncts) {
					for (const one of inputReads(conjunct)) readByRows.add(one.uuid);
					const prompt =
						conjunct.kind === "when-input-present"
							? input.prompts.find(
									(one) =>
										one.exclude && one.uuid === conjunct.input.searchInputUuid,
								)
							: undefined;
					if (
						prompt !== undefined &&
						simpleDerivation(doc, module.uuid, caseType, prompt, conjunct) !==
							undefined
					)
						derivable.add(prompt.uuid);
				}
		}
	}
	// The rewrites each held row is read up to, reported once the menu's rows print back.
	const rowRewrites = new Set<EmissionRewriteId>();
	// Whether a held row names a selection by a spelling the first publish writes as Nova's.
	let selectionRespelled = false;
	for (const row of input.rows) {
		const contexts = moduleExpressionContexts(doc, module.uuid, naming);
		let read = readSearchRowConjuncts(
			row.text,
			contexts({ slot: "case_search_filter" }),
			{ ...env, doc },
		);
		// A row the list filter's slot does not admit can be an advanced field's own condition,
		// which only HQ's search evaluates: it is read in that field's slot, the first excluded
		// field's that admits it, and can be that field's condition alone.
		let onlyField: PromptReading | undefined;
		if (!read.ok)
			for (const prompt of input.prompts) {
				const own = fieldConditionContext(contexts, prompt, derivedInputs);
				if (own === undefined) continue;
				const again = readSearchRowConjuncts(row.text, own, { ...env, doc });
				if (!again.ok) continue;
				read = again;
				onlyField = prompt;
				break;
			}
		const site = { json: row.cursor, key: "defaultValue" };
		// A system date compared with a value HQ's search refuses for it is the row's one cause:
		// HQ reads that comparison by its own date rule alone, so no other refusal of the row's,
		// and no place a conjunct of it could take, is a second finding.
		const anchorRefusal = read.uses.find(
			(use) =>
				use.key.startsWith("csql-metadata:") &&
				INVENTORY.entry(use.entryId)?.disposition === "REFUSED",
		);
		if (anchorRefusal !== undefined) {
			unread = true;
			claimRowKey(
				ctx,
				site,
				anchorRefusal.entryId,
				"schema:DefaultCaseSearchProperty.defaultValue",
				place,
				{ name: "_xpath_query" },
			);
			claimRowUses(ctx, row.cursor, read.uses, new Set(), place);
			continue;
		}
		if (!read.ok) unread = true;
		// The keys the row's own claims hold; each use its CSQL makes under
		// another key is claimed after them, held or not, under the entry
		// whose value class takes it.
		const claimed = new Set(["schema:DefaultCaseSearchProperty.defaultValue"]);
		const claimUses = () =>
			claimRowUses(ctx, row.cursor, read.uses, claimed, place);
		if (!read.ok) {
			// The row's own key, and the key the refusing entry is answered
			// under where that is another of its own (an operator, a function).
			if ("claim" in read) {
				claimed.add(read.claim.key);
				for (const key of new Set([
					"schema:DefaultCaseSearchProperty.defaultValue",
					read.claim.key,
				]))
					claimRowKey(
						ctx,
						site,
						read.claim.entryId,
						key,
						place,
						read.claim.detail,
					);
			} else
				ctx.accounting.circumstance("unrecognized", place, {
					name: "schema:DefaultCaseSearchProperty.defaultValue",
				});
			claimUses();
			continue;
		}
		ctx.accounting.claimEntry(
			site,
			ROWS_HELD,
			"schema:DefaultCaseSearchProperty.defaultValue",
			place,
		);
		// Each class of what the row works out on the device is a part of its value.
		const classes = new Set(
			read.conjuncts.flatMap((one) => searchRowRuntimeClasses(one)),
		);
		for (const [part, claim] of Object.entries(RUNTIME_CLAIMS))
			if (classes.has(part as SearchRowRuntimeClass))
				row.cursor.takePart("defaultValue", part, claim);
		const rowContext = contexts({ slot: "case_search_filter" });
		if (
			read.conjuncts.some((one) =>
				holdsHqConvertedComparison(one, rowContext, read.types),
			)
		)
			row.cursor.takePart(
				"defaultValue",
				"hq-converted-comparison",
				CONVERTED_CLAIMS.converted,
			);
		claimUses();
		for (const id of read.rewrites) rowRewrites.add(id);
		if (read.respelled) selectionRespelled = true;
		const rowIndex = input.rows.indexOf(row);
		// HQ joins every row with `and`, so two rows of one text are one condition wherever each
		// sits: a candidate writes this row back where it writes either.
		const isThisRow = (source: number) =>
			source === rowIndex || sameXPathText(sourceRows[source] ?? "", row.text);
		// Whether `candidate` writes this row back from `from`, and then whether every row it
		// matches is in the stored order; undefined where it does not write the row.
		const keepsOrder = (
			candidate: BlueprintDoc,
			from: "filter" | "field" | "derived",
		): boolean | undefined => {
			const match = matchSearchRows(candidate, module.uuid, sourceRows, {
				...env,
				doc: candidate,
			});
			if (
				!match.matched.some((one) => isThisRow(one.source) && one.from === from)
			)
				return undefined;
			const sources = match.matched.map((one) => one.source);
			return sources.every(
				(one, index) => index === 0 || (sources[index - 1] as number) <= one,
			);
		};
		for (const conjunct of read.conjuncts) {
			const record = (placement: ConjunctPlacement) =>
				conjuncts.push({ row: row.index, predicate: conjunct, placement });
			// B: a list filter clause restated: one the conjunct is, or one the conjunct is another
			// spelling of. Two spellings of a value can print one list filter and two rows (a date
			// and time's offset, which the device's comparison folds away and the row keeps), so the
			// clause takes the row's spelling where both print the stored filter and the row.
			const unmatched = (index: number) =>
				!restated.has(index) && onlyField === undefined;
			let clause = listClauses.findIndex(
				(one, index) => unmatched(index) && sameJson(one, conjunct),
			);
			// The run `run` of list clauses restated in `spelling`: the list filter with the run in that
			// spelling prints the stored filter and the row.
			const respelledBy = (
				run: readonly Expression[],
				spelling: Expression,
			): BlueprintDoc | undefined => {
				const filterText = listFilterText(ctx, doc, module.uuid);
				if (filterText === undefined) return undefined;
				const respelled = withListClauses(doc, module.uuid, run, spelling);
				if (respelled === undefined) return undefined;
				const text = listFilterText(ctx, respelled, module.uuid);
				if (text === undefined || !sameXPathText(text, filterText))
					return undefined;
				const rows = matchSearchRows(respelled, module.uuid, [row.text], {
					...env,
					doc: respelled,
				});
				return rows.matched.some((match) => match.from === "filter")
					? respelled
					: undefined;
			};
			// One clause in the row's own spelling, then the list's with the row's spelling of each date
			// and time, then the row's with each comparison oriented as the list's holds it; with
			// `unchanged`, the list's own, where the document as it stands writes the row.
			const respelledClause = (unchanged: boolean) =>
				listClauses.findIndex((one, index) => {
					if (!unmatched(index)) return false;
					for (const spelling of [
						conjunct,
						withInstantSpellings(one, conjunct),
						withOrientationOf(conjunct, one),
					]) {
						if (sameJson(spelling, one) !== unchanged) continue;
						const respelled = respelledBy([one], spelling);
						if (respelled === undefined) continue;
						doc = respelled;
						return true;
					}
					return false;
				});
			// B over a run: one conjunct the device prints as several top-level clauses (a choice list
			// tested for every value, `selected(tags, 'a') and selected(tags, 'b')`; a range, whose two
			// comparisons the device's reading keeps apart, `folds.ts::conjunctsPrintAsRows`), which the
			// device's filter splits and the row holds as one. The run takes the row's clause, else the
			// range its own two comparisons make (a date and time's range from a value to itself, which
			// the row reads as the equality it also prints), where the list filter with the run replaced
			// by it prints the stored filter and the row. It is tried before one clause in another
			// spelling and before a clause the unchanged document restates, since each of those
			// documents writes the row through the run's other clauses too.
			if (clause === -1 && read.conjuncts.length === 1) {
				const run = restatedRun(
					listClauses.length,
					(index) => unmatched(index),
					(start, end) => {
						const held = listClauses.slice(start, end);
						const range = rangeOfClauses(held);
						return (
							respelledBy(held, conjunct) ??
							(range === undefined || sameJson(range, conjunct)
								? undefined
								: respelledBy(held, range))
						);
					},
				);
				if (run !== undefined) {
					doc = run.doc;
					for (let index = run.start; index < run.end; index++)
						restated.add(index);
					record({ kind: "B", clause: run.start });
					continue;
				}
				clause = respelledClause(false);
				if (clause === -1) clause = respelledClause(true);
			}
			if (clause !== -1) {
				restated.add(clause);
				record({ kind: "B", clause });
				continue;
			}
			// C: a simple field's derivation. A field that already holds a conjunct as its condition is
			// no simple field: reading it as one would drop that conjunct.
			const prompt = input.prompts.find(
				(one) =>
					onlyField === undefined &&
					one.exclude &&
					!derivedInputs.has(one.uuid) &&
					!conditioned.has(one.uuid) &&
					conjunct.kind === "when-input-present" &&
					conjunct.input.searchInputUuid === one.uuid,
			);
			const derivation =
				prompt === undefined
					? undefined
					: simpleDerivation(doc, module.uuid, caseType, prompt, conjunct);
			const simple =
				prompt === undefined || derivation === undefined
					? undefined
					: withCandidate(derivation.doc, (draft) => {
							const inputs =
								draft.modules[module.uuid]?.caseListConfig?.searchInputs;
							const at =
								inputs?.findIndex((one) => one.uuid === prompt.uuid) ?? -1;
							const entry = inputs?.[at];
							if (
								inputs === undefined ||
								entry === undefined ||
								entry.kind !== "advanced"
							)
								return;
							const { predicate: _predicate, ...rest } = entry;
							inputs[at] = {
								...rest,
								kind: "simple",
								property: derivation.property,
								...(derivation.via !== undefined && { via: derivation.via }),
								...(derivation.mode !== undefined && { mode: derivation.mode }),
							} as SearchInputDef;
						});
			// A derivation is also the field's own condition (kind D's first candidate). Nova writes
			// field conditions before derivations, so where only the condition keeps the stored order
			// the row came from the condition, and kind D takes it.
			const conditionKeepsOrder =
				prompt !== undefined &&
				simple !== undefined &&
				keepsOrder(simple, "derived") === false &&
				keepsOrder(
					withCandidate(doc, (draft) =>
						setPredicate(
							draft as BlueprintDoc,
							module.uuid,
							prompt.uuid,
							conjunct,
						),
					),
					"field",
				) === true;
			if (
				prompt !== undefined &&
				derivation !== undefined &&
				simple !== undefined &&
				!conditionKeepsOrder
			) {
				derivedInputs.add(prompt.uuid);
				doc = simple;
				derivations.push({
					input: prompt.uuid,
					conjunct,
					at: conjuncts.length,
				});
				record({
					kind: "C",
					input: prompt.uuid,
					property: derivation.property,
					...(derivation.via !== undefined && { via: derivation.via }),
					...(derivation.mode !== undefined && { mode: derivation.mode }),
				});
				continue;
			}
			const reads = inputReads(conjunct);
			const candidates: {
				from: "field" | "filter";
				input?: Uuid;
				doc: BlueprintDoc;
				/** The derivation the candidate reads as its field's condition again. */
				undoes?: (typeof derivations)[number];
			}[] = [];
			// The field an earlier row read as a simple field's derivation, read as its condition
			// again with this conjunct joined: a condition one of whose conjuncts a simple field
			// derives is no simple field.
			const undoing = (
				derivation: (typeof derivations)[number],
			): (typeof candidates)[number] => ({
				from: "field",
				input: derivation.input,
				undoes: derivation,
				doc: withCandidate(doc, (draft) => {
					const inputs =
						draft.modules[module.uuid]?.caseListConfig?.searchInputs;
					const at =
						inputs?.findIndex((one) => one.uuid === derivation.input) ?? -1;
					const entry = inputs?.[at];
					if (inputs === undefined || entry?.kind !== "simple") return;
					const {
						property: _property,
						via: _via,
						mode: _mode,
						...rest
					} = entry as SimpleSearchInputDef;
					inputs[at] = {
						...rest,
						kind: "advanced",
						predicate: derivation.conjunct,
					} as SearchInputDef;
					setPredicate(
						draft as BlueprintDoc,
						module.uuid,
						derivation.input,
						conjunct,
					);
				}),
			});
			// A field that holds no condition (a simple or a hidden one) takes no conjunct: a
			// candidate that changes nothing is no placement.
			const fieldCandidate = (field: PromptReading) =>
				doc.modules[module.uuid]?.caseListConfig?.searchInputs.find(
					(one) => one.uuid === field.uuid,
				)?.kind === "advanced" &&
				candidates.push({
					from: "field",
					input: field.uuid,
					doc: withCandidate(doc, (draft) =>
						setPredicate(
							draft as BlueprintDoc,
							module.uuid,
							field.uuid,
							conjunct,
						),
					),
				});
			// The list filter holding the conjunct, where a device runs it: a list filter is
			// evaluated on the device, which runs no clause only HQ's search can (a fuzzy match).
			const filterDoc = withCandidate(doc, (draft) =>
				setFilter(draft as BlueprintDoc, module.uuid, conjunct),
			);
			const listHolds = deviceRunsList(doc, filterDoc, module.uuid);
			const filterCandidate = () => {
				if (listHolds) candidates.push({ from: "filter", doc: filterDoc });
			};
			// The excluded advanced fields that can take a condition, those that hold none yet first
			// and of those first the ones no row reads, each group in `properties` order: the holders
			// of a conjunct that reads another field outside its guard, and of a row only a field's
			// slot admits. A conjunct that reads no field is the search's own (below).
			const holders = () => {
				const all = input.prompts.filter(
					(field) =>
						field.exclude &&
						field.input.kind === "advanced" &&
						!derivedInputs.has(field.uuid),
				);
				const free = (field: PromptReading) => !conditioned.has(field.uuid);
				const unread = (field: PromptReading) => !readByRows.has(field.uuid);
				return [
					...all.filter((field) => free(field) && unread(field)),
					...all.filter((field) => free(field) && !unread(field)),
					...all.filter((field) => !free(field)),
				];
			};
			if (onlyField !== undefined) {
				// Read in a field's slot: the first field it reads where that field can take it, as
				// kind D's first candidate; one that reads no field, any field that can.
				const firstRead = input.prompts.find((one) =>
					reads.some((read_) => read_.uuid === one.uuid),
				);
				if (reads.length === 0)
					for (const field of holders()) fieldCandidate(field);
				else if (
					firstRead !== undefined &&
					fieldConditionContext(contexts, firstRead, derivedInputs) !==
						undefined
				)
					fieldCandidate(firstRead);
				else fieldCandidate(onlyField);
			} else if (reads.length > 0) {
				// D: the field's own condition, then a list clause that waits for its fields, or else the
				// condition of another excluded field, which may read fields not its own.
				const firstPrompt = input.prompts.find((one) =>
					reads.some((read_) => read_.uuid === one.uuid),
				);
				const own =
					firstPrompt?.exclude === true && !derivedInputs.has(firstPrompt.uuid)
						? firstPrompt
						: undefined;
				// A field another row derives as a simple field takes no condition that
				// reads it outside its guard, which no simple field's row does.
				const ownDerived =
					own !== undefined &&
					derivable.has(own.uuid) &&
					reads.some((read_) => !read_.guarded);
				if (own !== undefined && !ownDerived) fieldCandidate(own);
				const guarded = reads.every((one) => one.guarded);
				const waits = waitsForFields(conjunct);
				// A conjunct a device prints nothing for in the list's own filter is a clause of the list
				// filter that waits for its fields, whether a presence test or the device covers its reads.
				if (waits) filterCandidate();
				// One that reads a field outside its guard, on the device, or that a device prints in the
				// list's own filter, may be another excluded field's condition.
				if (!guarded || !waits)
					for (const field of holders())
						if (field.uuid !== own?.uuid && !derivable.has(field.uuid))
							fieldCandidate(field);
				// A field an earlier row read as a simple field's derivation, read as its condition
				// again with this conjunct joined: a condition one of whose conjuncts a simple field
				// derives is no simple field. Where the conjunct reads a field outside its guard, any
				// such field; where it reads every field under its guard, the first field it reads, whose
				// own condition the conjunct is where the list filter holding it would write the rows out
				// of the stored order (`filterConditionsOfAFieldAreItsOwn`): Nova writes the list
				// filter's rows before every field's.
				for (const derivation of guarded
					? derivations.filter((one) => one.input === firstPrompt?.uuid)
					: derivations) {
					if (conjuncts[derivation.at]?.placement.kind !== "C") continue;
					candidates.push(undoing(derivation));
				}
			} else {
				// A conjunct that reads no field is a condition on the whole search, never on a field
				// (`searchConditions.ts::readsSearchField`): the search's own filter joined to the list
				// filter (F) on a menu whose forms read the search, where the device's list filter reads
				// it as HQ's search does (`joinReadsAlike`), and else the search condition alone (F,
				// below). Nova writes every field's conjunct that reads no field with the search
				// condition's rows, ahead of the fields' (`xpathQuery.ts::composeXPathQueryClauses`),
				// so a reading of Nova's export gives the search condition again, and a source that
				// holds such a row after a field's is written in Nova's order
				// (`search-filter-rows-recut`), which finds the same cases.
				if (ownsFilter && joinReadsAlike(conjunct, doc, caseType))
					filterCandidate();
			}
			// A conjunct that reads a field outside its presence guard is no condition Nova prints in
			// either slot (the gate's `searchInputRefUsesWhenInputPresent`), so neither candidate holds it.
			const unguarded = unguardedSearchInputReads(conjunct);
			const passing = (unguarded.length > 0 ? [] : candidates).flatMap(
				(candidate) => {
					const inOrder = keepsOrder(candidate.doc, candidate.from);
					return inOrder === undefined ? [] : [{ ...candidate, inOrder }];
				},
			);
			const chosen = passing.find((one) => one.inOrder) ?? passing[0];
			// F: the search's own filter, joined to the list filter.
			const joinsFilter =
				reads.length === 0 &&
				onlyField === undefined &&
				ownsFilter &&
				listHolds &&
				joinReadsAlike(conjunct, doc, caseType) &&
				(chosen === undefined || chosen.from === "filter");
			if (joinsFilter) {
				doc = chosen?.doc ?? filterDoc;
				record({ kind: "F" });
				continue;
			}
			if (chosen !== undefined) {
				doc = chosen.doc;
				const undone = chosen.undoes;
				if (undone !== undefined) {
					derivedInputs.delete(undone.input);
					derivations.splice(derivations.indexOf(undone), 1);
					const earlier = conjuncts[undone.at];
					if (earlier !== undefined)
						conjuncts[undone.at] = {
							...earlier,
							placement: { kind: "D", from: "field", input: undone.input },
						};
				}
				if (chosen.from === "field" && chosen.input !== undefined)
					conditioned.add(chosen.input);
				if (
					chosen.from === "field" &&
					chosen.input !== undefined &&
					passing.some((one) => one.from === "filter")
				)
					fieldConditions.push({
						input: chosen.input,
						conjunct,
						at: conjuncts.length,
					});
				record({
					kind: "D",
					from: chosen.from,
					...(chosen.input !== undefined && { input: chosen.input }),
				});
				continue;
			}
			// An independent server condition owns a matched or excluded
			// prompt's value without changing its own matching behavior.
			const claim =
				unguarded.length === 0
					? ROW_CLAIMS.noSlot
					: unguarded.every(
								(uuid) =>
									input.prompts.find((one) => one.uuid === uuid)?.exclude ===
									true,
							)
						? ROW_CLAIMS.readsExcludedField
						: ROW_CLAIMS.readsMatchedField;
			row.cursor.takePart("defaultValue", "independent-condition", claim);
			record({ kind: "F" });
		}
	}

	// A field read as a simple field's derivation is that field only where the search it writes is
	// the one its own condition writes, row for row (the canonical choice
	// `derived-search-conditions-are-simple-fields`). Each row was placed before the later rows,
	// whose fields can move a derivation's row behind theirs. Over the settled menu, where the
	// simple readings write the rows out of the stored order, the fewest of them read as their
	// conditions instead under which the rows come back in the stored order are.
	const writesInOrder = (candidate: BlueprintDoc) => {
		const match = matchSearchRows(candidate, module.uuid, sourceRows, {
			...env,
			doc: candidate,
		});
		const sources = match.matched.map((one) => one.source);
		return (
			match.unmatched.length === 0 &&
			sources.every(
				(one, index) => index === 0 || (sources[index - 1] as number) <= one,
			)
		);
	};
	if (
		derivations.length > 0 &&
		derivations.length <= MAX_DERIVATIONS_RECONSIDERED &&
		!writesInOrder(doc)
	) {
		const asConditions = (chosen: readonly (typeof derivations)[number][]) =>
			withCandidate(doc, (draft) => {
				const inputs = draft.modules[module.uuid]?.caseListConfig?.searchInputs;
				for (const derivation of chosen) {
					const at =
						inputs?.findIndex((one) => one.uuid === derivation.input) ?? -1;
					const entry = inputs?.[at];
					if (inputs === undefined || entry?.kind !== "simple") continue;
					const {
						property: _property,
						via: _via,
						mode: _mode,
						...rest
					} = entry as SimpleSearchInputDef;
					inputs[at] = {
						...rest,
						kind: "advanced",
						predicate: derivation.conjunct,
					} as SearchInputDef;
				}
			});
		const subsets = Array.from(
			{ length: 2 ** derivations.length - 1 },
			(_, index) => derivations.filter((_, bit) => ((index + 1) >> bit) & 1),
		).sort((a, b) => a.length - b.length);
		for (const chosen of subsets) {
			const candidate = asConditions(chosen);
			if (!writesInOrder(candidate)) continue;
			doc = candidate;
			for (const derivation of chosen) {
				const record = conjuncts[derivation.at];
				if (record !== undefined)
					conjuncts[derivation.at] = {
						...record,
						placement: { kind: "D", from: "field", input: derivation.input },
					};
			}
			break;
		}
	}

	// A conjunct placed as an advanced field's own condition where the list filter could also take
	// it, or as a simple field's derivation, keeps the rows placed so far in order, but Nova writes
	// the list filter's rows before field conditions and derivations, so a later row can show the
	// conjunct was the list filter's. Over the settled menu, where the rows come out of the stored
	// order, the fewest of those conjuncts read as list filter clauses instead, each among the list
	// filter's clauses in row order, under which they come back in order and the device runs the
	// list, are. One that reads Search fields waits for them, so the device's own list filter prints
	// the same; one that reads none is a clause the device's list filter runs, the search's own
	// filter joined to the list (kind F), offered only where kind F is.
	const joinsList = (conjunct: Expression) =>
		ownsFilter && joinReadsAlike(conjunct, doc, caseType);
	const movable = [
		...fieldConditions
			.filter(
				(one) => inputReads(one.conjunct).length > 0 || joinsList(one.conjunct),
			)
			.map((one) => ({ ...one, from: "field" as const })),
		...derivations
			.filter((one) => conjuncts[one.at]?.placement.kind === "C")
			.map((one) => ({ ...one, from: "derived" as const })),
	].sort((a, b) => a.at - b.at);
	if (
		movable.length > 0 &&
		movable.length <= MAX_DERIVATIONS_RECONSIDERED &&
		!writesInOrder(doc)
	) {
		const asFilter = (chosen: readonly (typeof movable)[number][]) => {
			const fromFilter = new Set(
				conjuncts.flatMap((one, index) =>
					(one.placement.kind === "D" && one.placement.from === "filter") ||
					one.placement.kind === "F"
						? [index]
						: [],
				),
			);
			return withCandidate(doc, (draft) => {
				for (const one of chosen) {
					if (one.from === "field")
						withoutPredicateClause(
							draft as BlueprintDoc,
							module.uuid,
							one.input,
							one.conjunct,
						);
					else asExcludedField(draft as BlueprintDoc, module.uuid, one.input);
					// Before the first clause a later row's conjunct put in the list filter.
					const later = [...fromFilter]
						.sort((a, b) => a - b)
						.find((index) => index > one.at);
					insertFilterClause(
						draft as BlueprintDoc,
						module.uuid,
						one.conjunct,
						later === undefined ? undefined : conjuncts[later]?.predicate,
					);
					fromFilter.add(one.at);
				}
			});
		};
		const subsets = Array.from(
			{ length: 2 ** movable.length - 1 },
			(_, index) => movable.filter((_, bit) => ((index + 1) >> bit) & 1),
		).sort((a, b) => a.length - b.length);
		for (const chosen of subsets) {
			const candidate = asFilter(chosen);
			if (
				!writesInOrder(candidate) ||
				!deviceRunsList(doc, candidate, module.uuid)
			)
				continue;
			doc = candidate;
			for (const one of chosen) {
				const record = conjuncts[one.at];
				if (record !== undefined)
					conjuncts[one.at] = {
						...record,
						placement:
							inputReads(one.conjunct).length === 0
								? { kind: "F" }
								: { kind: "D", from: "filter" },
					};
			}
			break;
		}
	}
	// Only a field-owned conjunct can be supplied by its prompt. Every
	// remaining conjunct stays with the ordered online request. Restore
	// the original detail even when a candidate tested a joined spelling.
	const requestConditions = conjuncts.filter(
		(one) =>
			one.placement.kind === "B" ||
			one.placement.kind === "F" ||
			(one.placement.kind === "D" && one.placement.from === "filter"),
	);
	const requestCondition = requestConditions.reduce<Expression | undefined>(
		(result, one) => joinedFilter(result, one.predicate),
		undefined,
	);
	const unrestated = listClauses.flatMap((_, index) =>
		restated.has(index) ? [] : [index],
	);
	// The list's filter, in the spelling a restating row gave a clause of it where that prints
	// the stored filter (kind B), where every row restated it.
	const listNow = doc.modules[module.uuid]?.caseListConfig?.filter;
	const combined = withCandidate(doc, (draft) => {
		const config = draft.modules[module.uuid]?.caseListConfig;
		if (config)
			replaceCaseConditions(config, { filter: requestCondition ?? null });
	});
	const originally = listFilterText(ctx, start, module.uuid);
	const shared = listFilterText(ctx, combined, module.uuid);
	doc =
		// Every row restates the list and every clause of the list is restated: the one filter
		// both send, in the list's own spelling.
		requestConditions.length > 0 &&
		requestConditions.every((one) => one.placement.kind === "B") &&
		listClauses.length > 0 &&
		unrestated.length === 0 &&
		!unread
			? withCandidate(doc, (draft) => {
					const config = draft.modules[module.uuid]?.caseListConfig;
					if (config)
						replaceCaseConditions(config, { filter: listNow ?? null });
				})
			: originally !== undefined &&
					shared !== undefined &&
					(originally === shared ||
						(originally !== "" &&
							shared !== "" &&
							sameXPathText(originally, shared))) &&
					(typesAsListFilter(combined, module.uuid, naming) ||
						!typesAsListFilter(start, module.uuid, naming))
				? combined
				: withCandidate(doc, (draft) => {
						const config = draft.modules[module.uuid]?.caseListConfig;
						if (config)
							replaceCaseConditions(config, {
								listCondition: mod.caseListConfig?.filter ?? null,
								searchCondition: requestCondition ?? null,
							});
					});
	if (unrestated.length > 0 && !unread) takeUnrestatedDetail(ctx, module);
	// Nova's emission of the settled menu writes every source row back. A search of HQ's two
	// markers alone is Nova's search with no fields and no filter, whose zero-input row Nova writes
	// in their place: that row is the one the emission must write.
	const markersRow = input.markersOnly === true && input.rows.length === 0;
	const settled = matchSearchRows(
		doc,
		module.uuid,
		markersRow ? [ZERO_INPUT_ROW] : sourceRows,
		{ ...env, doc },
	);
	const sources = settled.matched.map((one) => one.source);
	const inOrder = sources.every(
		(one, index) => index === 0 || (sources[index - 1] as number) <= one,
	);
	// Nova's emission restates every clause of the list filter as a row of its own, so each clause
	// no row restates is a row it adds: held where the menu's forms read the search, and the one
	// finding at the list otherwise, which stands for the rows it adds.
	const extraAllowed = 0;
	if (settled.unmatched.length > 0 || settled.extra.length > extraAllowed) {
		// A field's check whose refusal its settle has yet to apply stands at the search too.
		if (!ctx.accounting.hasFindingAt(place) && !refusalDeferredAt(ctx, place))
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:DefaultCaseSearchProperty.defaultValue",
			});
	} else {
		if (
			!inOrder ||
			conjuncts.length !== input.rows.length ||
			markersRow ||
			selectionRespelled
		)
			sameState(
				ctx,
				markersRow ? MARKERS_HELD : ROWS_HELD,
				`${module.json.pointer}/search_config/default_properties`,
				"search-filter-rows-recut",
			);
		// A row held at its guards level is printed with the rewrites it was read up to, which
		// change what the first publish's search does (`emissionRewrites.ts`), so the reading
		// reports each, as the expression stage reports a slot's.
		for (const id of rowRewrites)
			if (
				EMISSION_REWRITES[id].behavior === "changes" &&
				!ctx.facts.rewrites.some(
					(one) =>
						one.id === id &&
						one.key === "schema:DefaultCaseSearchProperty.defaultValue" &&
						sameJson(one.place, place),
				)
			)
				ctx.facts.rewrites.push({
					id,
					place,
					key: "schema:DefaultCaseSearchProperty.defaultValue",
					pointer: `${module.json.pointer}/search_config/default_properties`,
				});
	}
	ctx.doc = doc;
	return { conjuncts, unrestated };
}
