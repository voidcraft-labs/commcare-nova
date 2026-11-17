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
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import type { RelationPath } from "@/lib/domain/expression/types";
import {
	substituteUnansweredSearchInputs,
	walkExpressionTerms,
} from "@/lib/domain/expression/walk";
import {
	moduleFormsReadSearch,
	type SearchInputMode,
	type SimpleSearchInputDef,
} from "@/lib/domain/modules";
import { USERCASE_BUILT_IN_KEYS } from "@/lib/domain/usercase";
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
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "../../suite/case-search/simpleArmDerivation";
import { ZERO_INPUT_SEARCH_SENTINEL } from "../../suite/case-search/xpathQuery";
import { unguardedSearchInputReads } from "../../validator/rules/case-list/searchInputRefUsesWhenInputPresent";
import type { FormSyntax } from "../../xpath/formSyntax";
import { withCandidate } from "../candidate";
import { sameState } from "../caseList/details";
import { defineClaims, refuse } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import type { ComparedType } from "../expressions/comparedTypes";
import { core, flat, instanceId } from "../expressions/folds";
import { searchRowProperties } from "../expressions/scanReads";
import {
	emittedSearchConjuncts,
	matchSearchRows,
	readSearchRowConjuncts,
} from "../expressions/searchRows";
import { externalKey, mintEntityUuid } from "../identity";
import { isJsonObject, sameJson } from "../jsonCursor";
import { readProjectionInputs } from "../projectionInputs";
import { refusalDeferredAt } from "../provisional";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { PromptReading } from "./prompts";
import { searchPlace } from "./workflow";

const S = "case-search/";

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
	readsMatchedField: refuse(
		`${S}xpath-query-row-reading-a-field-hq-also-matches`,
		"schema:CaseSearch.default_properties",
	),
	readsExcludedField: refuse(
		`${S}xpath-query-row-reading-an-excluded-field-outside-its-presence-guard`,
		"schema:CaseSearch.default_properties",
	),
	noSlot: refuse(
		`${S}xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s`,
		"schema:CaseSearch.default_properties",
	),
	unrestated: refuse(
		`${S}case-list-filter-clause-the-search-does-not-restate`,
		"schema:Detail.filter",
	),
});

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

/** Every Search field a tree reads, and whether each read sits under its own presence guard. */
function inputReads(expression: unknown): { uuid: Uuid; guarded: boolean }[] {
	const out: { uuid: Uuid; guarded: boolean }[] = [];
	const walk = (node: unknown, guards: ReadonlySet<string>): void => {
		if (Array.isArray(node)) {
			for (const one of node) walk(one, guards);
			return;
		}
		if (!isJsonObject(node)) return;
		if (node.kind === "when-input-present" && isJsonObject(node.input)) {
			const uuid = node.input.searchInputUuid as string;
			// The presence test reads its field, under its own guard.
			out.push({ uuid: uuid as Uuid, guarded: true });
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
): { property: string; via?: RelationPath }[] {
	const out: { property: string; via?: RelationPath }[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const one of node) walk(one);
			return;
		}
		if (!isJsonObject(node)) return;
		if (node.kind === "prop" && typeof node.property === "string") {
			out.push({
				property: node.property,
				...(node.via !== undefined && { via: node.via as RelationPath }),
			});
			return;
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

/** The simple field whose derivation, in `doc`'s own types, is `conjunct`, for the visible field
 *  `input` it waits for; undefined where no property, path and mode derive it. */
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
	for (const ref of propertyRefs(conjunct.clause))
		for (const mode of modes) {
			const candidate = {
				...shared,
				kind: "simple",
				property: ref.property,
				...(ref.via !== undefined && { via: ref.via }),
				...(mode !== undefined && { mode }),
			} as SimpleSearchInputDef;
			if (!simpleArmNeedsXPathQueryEmission(candidate)) continue;
			let derived: Expression;
			try {
				derived = deriveSimpleArmPredicate(candidate, caseType, context);
			} catch {
				continue;
			}
			if (sameJson(derived, conjunct)) return candidate;
		}
	return undefined;
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
 * fields unanswered, `deviceFilter`), and, where a field's condition sent the row, the first
 * advanced field holds it (`classifySearchRows`, which places a row that reads no field on the
 * first field it can), or the filter does on a menu whose forms read the search where joining it
 * leaves what a device prints there as it was.
 */
export function searchesThatFindNothingAsRead(doc: BlueprintDoc): BlueprintDoc {
	let out = doc;
	for (const moduleUuid of doc.moduleOrder) {
		const config = out.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) continue;
		const conjuncts = emittedSearchConjuncts(out, moduleUuid);
		const [only, ...more] = conjuncts;
		if (only?.kind !== "match-none" || more.length > 0) continue;
		const fromFilter =
			effectiveFilterForEmission(config.filter)?.kind === "match-none";
		// No row of the filter's is sent, so it prints only as a device reads
		// it, its Search fields unanswered.
		const device = deviceFilter(config.filter);
		// On a menu whose forms read the search a row that reads no field joins
		// the filter first, where a device's list filter prints the same with
		// it joined (`classifySearchRows`, kind F).
		const module = out.modules[moduleUuid];
		const ownsFilter =
			module !== undefined &&
			moduleFormsReadSearch(module) &&
			!listLoadedByAdvancedForm(out, moduleUuid) &&
			joinKeepsDeviceFilter(device, { kind: "match-none" });
		const next = withCandidate(out, (draft) => {
			const list = draft.modules[moduleUuid]?.caseListConfig;
			const inputs = list?.searchInputs;
			if (list === undefined || inputs === undefined) return;
			if (device === undefined) delete list.filter;
			else list.filter = device;
			if (!fromFilter && ownsFilter)
				setFilter(draft as BlueprintDoc, moduleUuid, { kind: "match-none" });
			let holder = fromFilter || ownsFilter;
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
					predicate: { kind: holder ? "match-all" : "match-none" },
				} as SearchInputDef;
				holder = true;
			});
		});
		if (!sameJson(next, out)) out = next;
	}
	return out;
}

/**
 * The reader's canonical choice `search-filter-conditions-of-a-field-are-its-own`: a top-level
 * conjunct of a searched case list's filter that reads Search fields, each under its own presence
 * test, prints no clause of the list's own filter (a device reads no answer there,
 * `caseList.ts::projectCaseListFilter`) and the row the same conjunct of the first field it reads
 * prints as that field's condition, where that field is an advanced one; the reader places such a
 * row on that field (`classifySearchRows`, kind D), ahead of the field's own rows, since Nova
 * writes the filter's rows first.
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
			module.caseSearchConfig === undefined
		)
			continue;
		const [only, ...more] = emittedSearchConjuncts(out, moduleUuid);
		if (only?.kind === "match-none" && more.length === 0) continue;
		const clauses = topLevel(effectiveFilterForEmission(config.filter));
		const moved = new Map<Uuid, Expression[]>();
		const kept: Expression[] = [];
		for (const clause of clauses) {
			const reads = inputReads(clause);
			const first = config.searchInputs.find((input) =>
				reads.some((read) => read.uuid === input.uuid),
			);
			if (
				reads.length === 0 ||
				!reads.every((read) => read.guarded) ||
				first?.kind !== "advanced"
			) {
				kept.push(clause);
				continue;
			}
			moved.set(first.uuid, [...(moved.get(first.uuid) ?? []), clause]);
		}
		if (moved.size === 0) continue;
		out = withCandidate(out, (draft) => {
			const list = draft.modules[moduleUuid]?.caseListConfig;
			if (list === undefined) return;
			const [head, ...rest] = kept;
			if (head === undefined) delete list.filter;
			else
				list.filter =
					rest.length === 0 ? head : { kind: "and", clauses: [head, ...rest] };
			for (const input of list.searchInputs) {
				const taken = moved.get(input.uuid);
				if (taken === undefined || input.kind !== "advanced") continue;
				const own = topLevel(effectiveFilterForEmission(input.predicate));
				const [first, ...others] = [...taken, ...own];
				if (first !== undefined)
					input.predicate =
						others.length === 0
							? first
							: { kind: "and", clauses: [first, ...others] };
			}
		});
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
 *  is the conjunct; a date field over a property typed `date`, then `datetime`. */
function simpleDerivation(
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
					const type = draft.caseTypes?.find((one) => one.name === caseType);
					for (const ref of propertyRefs(conjunct)) {
						const property = type?.properties.find(
							(one) => one.name === ref.property,
						);
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
				const derived = read.ok
					? read.conjuncts.find(
							(conjunct) =>
								derivedField(
									candidate,
									module.uuid,
									caseType,
									prompt.input,
									conjunct,
								) !== undefined,
						)
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
		const scratch = over.userProperties ?? {};
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
	} catch {
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
		const properties = draft.userProperties ?? {};
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
	} catch {
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
	} catch {
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
		if (input.formsReadSearch)
			sameState(
				ctx,
				ROWS_HELD,
				`${module.json.pointer}/search_config/default_properties`,
				"search-restates-list-filter",
			);
		else
			ctx.accounting.finding(ROW_CLAIMS.unrestated, {
				kind: "case-list",
				menu: module.index,
				name: place.kind === "search" ? place.name : "",
			});
		return { conjuncts, unrestated };
	}
	// The fields some row reads: a row that reads a field is that field's (its derivation or its own
	// condition), so a conjunct that reads no field is a holder's that no row reads first.
	const readByRows = new Set<Uuid>();
	{
		const contexts = moduleExpressionContexts(doc, module.uuid, naming);
		for (const row of input.rows) {
			const read = readSearchRowConjuncts(
				row.text,
				contexts({ slot: "case_list_filter" }),
				{ ...env, doc },
			);
			if (read.ok)
				for (const conjunct of read.conjuncts)
					for (const one of inputReads(conjunct)) readByRows.add(one.uuid);
		}
	}
	// The rewrites each held row is read up to, reported once the menu's rows print back.
	const rowRewrites = new Set<EmissionRewriteId>();
	for (const row of input.rows) {
		const contexts = moduleExpressionContexts(doc, module.uuid, naming);
		let read = readSearchRowConjuncts(
			row.text,
			contexts({ slot: "case_list_filter" }),
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
		if (!read.ok) unread = true;
		const site = { json: row.cursor, key: "defaultValue" };
		// The keys the row's own claims hold; each use its CSQL makes under
		// another key is claimed after them, held or not, under the entry
		// whose value class takes it.
		const claimed = new Set(["schema:DefaultCaseSearchProperty.defaultValue"]);
		const claimUses = () => {
			for (const use of read.uses)
				if (!claimed.has(use.key)) {
					claimed.add(use.key);
					ctx.accounting.claimEntry(site, use.entryId, use.key, place, {
						name: "_xpath_query",
					});
				}
		};
		if (!read.ok) {
			// The row's own key, and the key the refusing entry is answered
			// under where that is another of its own (an operator, a function).
			if ("claim" in read) {
				claimed.add(read.claim.key);
				for (const key of new Set([
					"schema:DefaultCaseSearchProperty.defaultValue",
					read.claim.key,
				]))
					ctx.accounting.claimEntry(
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
		claimUses();
		for (const id of read.rewrites) rowRewrites.add(id);
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
			// and time; with `unchanged`, the list's own, where the document as it stands writes the row.
			const respelledClause = (unchanged: boolean) =>
				listClauses.findIndex((one, index) => {
					if (!unmatched(index)) return false;
					for (const spelling of [
						conjunct,
						withInstantSpellings(one, conjunct),
					]) {
						if (sameJson(spelling, one) !== unchanged) continue;
						const respelled = respelledBy([one], spelling);
						if (respelled === undefined) continue;
						doc = respelled;
						return true;
					}
					return false;
				});
			if (clause === -1 && read.conjuncts.length === 1)
				clause = respelledClause(false);
			// B over a run: one conjunct the device prints as several top-level clauses (a choice list
			// tested for every value, `selected(tags, 'a') and selected(tags, 'b')`), which the device's
			// filter splits and the row holds as one. The run takes the row's clause where the list filter
			// with the run replaced by it prints the stored filter and the row. It is tried before a clause
			// the unchanged document restates, since that document writes the row whichever clause of the
			// run is named.
			if (clause === -1 && read.conjuncts.length === 1) {
				const run = restatedRun(
					listClauses.length,
					(index) => unmatched(index),
					(start, end) => respelledBy(listClauses.slice(start, end), conjunct),
				);
				if (run !== undefined) {
					doc = run.doc;
					for (let index = run.start; index < run.end; index++)
						restated.add(index);
					record({ kind: "B", clause: run.start });
					continue;
				}
				clause = respelledClause(true);
			}
			if (clause !== -1) {
				restated.add(clause);
				record({ kind: "B", clause });
				continue;
			}
			// C: a simple field's derivation.
			const prompt = input.prompts.find(
				(one) =>
					onlyField === undefined &&
					one.exclude &&
					!derivedInputs.has(one.uuid) &&
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
			}[] = [];
			const fieldCandidate = (field: PromptReading) =>
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
			// Every clause of the list filter is also a clause a device prints in the list's own
			// filter (`caseList.ts::projectCaseListFilter`), so a row joins it ahead of a field only
			// where that print stays the stored one.
			const filterJoinKeepsList = () => {
				const before = listFilterText(ctx, doc, module.uuid);
				const after = listFilterText(
					ctx,
					withCandidate(doc, (draft) =>
						setFilter(draft as BlueprintDoc, module.uuid, conjunct),
					),
					module.uuid,
				);
				return (
					before !== undefined &&
					after !== undefined &&
					(before === "" || after === ""
						? before === after
						: sameXPathText(before, after))
				);
			};
			const filterCandidate = () =>
				candidates.push({
					from: "filter",
					doc: withCandidate(doc, (draft) =>
						setFilter(draft as BlueprintDoc, module.uuid, conjunct),
					),
				});
			// The excluded advanced fields that can take a condition, those that hold none yet first
			// and of those first the ones no row reads, each group in `properties` order. Nova writes one row per top-level conjunct of each
			// field's condition, field after field, so a run of rows that read no field prints the
			// same whichever of the fields holds each: each row is its own field's where the fields
			// allow it.
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
				// D: the field's own condition, then a list clause that waits for its fields.
				const firstPrompt = input.prompts.find((one) =>
					reads.some((read_) => read_.uuid === one.uuid),
				);
				if (firstPrompt?.exclude && !derivedInputs.has(firstPrompt.uuid))
					fieldCandidate(firstPrompt);
				if (reads.every((one) => one.guarded)) filterCandidate();
			} else {
				// A conjunct that reads no field: the search's own filter (F) on a menu whose forms
				// read the search, then the condition of an excluded field, which may read no field.
				// A join that changes what the list's own filter prints comes after every field.
				const keeps = ownsFilter && filterJoinKeepsList();
				if (keeps) filterCandidate();
				for (const field of holders()) fieldCandidate(field);
				if (ownsFilter && !keeps) filterCandidate();
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
				(chosen === undefined || chosen.from === "filter");
			if (joinsFilter) {
				doc =
					chosen?.doc ??
					withCandidate(doc, (draft) =>
						setFilter(draft as BlueprintDoc, module.uuid, conjunct),
					);
				sameState(
					ctx,
					ROWS_HELD,
					`${module.json.pointer}/case_details/short/filter`,
					"search-filter-joined-to-list",
				);
				record({ kind: "F" });
				continue;
			}
			if (chosen !== undefined) {
				doc = chosen.doc;
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
			// An unguarded read of an excluded field alone is the excluded field's own entry: HQ's
			// matcher does not compare that field, and the row compares a blank while it is unanswered.
			const claim =
				reads.length === 0
					? ROW_CLAIMS.noSlot
					: unguarded.length > 0 &&
							unguarded.every(
								(uuid) =>
									input.prompts.find((one) => one.uuid === uuid)?.exclude ===
									true,
							)
						? ROW_CLAIMS.readsExcludedField
						: ROW_CLAIMS.readsMatchedField;
			ctx.accounting.finding(claim, place);
			record({ kind: "E", entry: claim.entry });
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

	// A conjunct that reads Search fields under their guards is placed as the first field's own
	// condition, or as a simple field's derivation, where that keeps the rows placed so far in
	// order, but Nova writes the list filter's rows before field conditions and derivations, so a
	// later row can show the conjunct was the list filter's. Over the settled menu, where the rows
	// come out of the stored order, the fewest of those conjuncts read as list filter clauses
	// instead, each among the list filter's clauses in row order, under which they come back in
	// order are.
	const movable = [
		...fieldConditions.map((one) => ({ ...one, from: "field" as const })),
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
			if (!writesInOrder(candidate)) continue;
			doc = candidate;
			for (const one of chosen) {
				const record = conjuncts[one.at];
				if (record !== undefined)
					conjuncts[one.at] = {
						...record,
						placement: { kind: "D", from: "filter" },
					};
			}
			break;
		}
	}

	const unrestated = listClauses.flatMap((_, index) =>
		restated.has(index) ? [] : [index],
	);
	// A search that sends `match-none()` finds nothing, and Nova sends no other row beside it
	// (`xpathQuery.ts::composeXPathQueryClauses`), so a list clause it leaves out restates nothing.
	const findsNothing = conjuncts.some(
		(one) => one.predicate.kind === "match-none",
	);
	if (unrestated.length > 0 && !unread && !findsNothing) {
		if (input.formsReadSearch)
			sameState(
				ctx,
				ROWS_HELD,
				`${module.json.pointer}/search_config/default_properties`,
				"search-restates-list-filter",
			);
		else
			ctx.accounting.finding(ROW_CLAIMS.unrestated, {
				kind: "case-list",
				menu: module.index,
				name: place.kind === "search" ? place.name : "",
			});
	}

	// (R2): Nova's emission of the settled menu writes every source row back. A search of HQ's two
	// markers alone is Nova's search with no fields and no filter, whose zero-input row Nova writes
	// in their place: that row is the one the emission must write.
	const markersRow =
		input.markersOnly === true &&
		input.rows.length === 0 &&
		listClauses.length === 0;
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
	const extraAllowed = input.formsReadSearch ? unrestated.length : 0;
	if (settled.unmatched.length > 0 || settled.extra.length > extraAllowed) {
		// A field's check whose refusal its settle has yet to apply stands at the search too.
		if (!ctx.accounting.hasFindingAt(place) && !refusalDeferredAt(ctx, place))
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:DefaultCaseSearchProperty.defaultValue",
			});
	} else {
		if (!inOrder || conjuncts.length !== input.rows.length || markersRow)
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
				});
	}
	ctx.doc = doc;
	return { conjuncts, unrestated };
}
