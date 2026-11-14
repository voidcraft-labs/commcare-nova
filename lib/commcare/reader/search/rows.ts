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
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import type { RelationPath } from "@/lib/domain/expression/types";
import type {
	SearchInputMode,
	SimpleSearchInputDef,
} from "@/lib/domain/modules";
import { moduleExpressionContexts } from "../../expressionContext";
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "../../suite/case-search/simpleArmDerivation";
import { withCandidate } from "../candidate";
import { sameState } from "../caseList/details";
import { defineClaims, refuse } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import {
	emittedSearchConjuncts,
	matchSearchRows,
	readSearchRowConjuncts,
} from "../expressions/searchRows";
import { isJsonObject, sameJson } from "../jsonCursor";
import { readProjectionInputs } from "../projectionInputs";
import type { PromptReading } from "./prompts";
import { searchPlace } from "./workflow";

const S = "case-search/";

/** The entry the rows are held under, each top-level conjunct placed. */
export const ROWS_HELD = `${S}several-xpath-query-rows`;

export const ROW_CLAIMS = defineClaims("search.rows", {
	readsMatchedField: refuse(
		`${S}xpath-query-row-reading-a-field-hq-also-matches`,
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

function setFilter(
	draft: BlueprintDoc,
	moduleUuid: Uuid,
	clause: Expression,
): void {
	const config = draft.modules[moduleUuid]?.caseListConfig;
	if (config === undefined) return;
	config.filter =
		config.filter === undefined || config.filter.kind === "match-all"
			? clause
			: {
					kind: "and",
					clauses: [...topLevel(config.filter), clause] as unknown as [
						Expression,
						...Expression[],
					],
				};
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
	const ownsFilter = input.formsReadSearch && !loadNamesMenu(ctx, module);

	if (input.zeroInput) {
		for (const row of input.rows)
			conjuncts.push({
				row: row.index,
				predicate: { kind: "match-all" },
				placement: { kind: "A" },
			});
		return { conjuncts, unrestated: [] };
	}
	for (const row of input.rows) {
		const context = moduleExpressionContexts(
			doc,
			module.uuid,
			naming,
		)({ slot: "case_list_filter" });
		const read = readSearchRowConjuncts(row.text, context, { ...env, doc });
		if (!read.ok) {
			if ("claim" in read)
				ctx.accounting.claimEntry(
					{ json: row.cursor, key: "defaultValue" },
					read.claim.entryId,
					"schema:DefaultCaseSearchProperty.defaultValue",
					place,
					read.claim.detail,
				);
			else
				ctx.accounting.circumstance("unrecognized", place, {
					name: "schema:DefaultCaseSearchProperty.defaultValue",
				});
			continue;
		}
		ctx.accounting.claimEntry(
			{ json: row.cursor, key: "defaultValue" },
			ROWS_HELD,
			"schema:DefaultCaseSearchProperty.defaultValue",
			place,
		);
		for (const conjunct of read.conjuncts) {
			const record = (placement: ConjunctPlacement) =>
				conjuncts.push({ row: row.index, predicate: conjunct, placement });
			// Whether `candidate` writes this conjunct's row back from `from`, every row it matches in
			// the stored order; undefined where it does not write the row.
			const keepsOrder = (
				candidate: BlueprintDoc,
				from: "field" | "derived",
			): boolean | undefined => {
				const match = matchSearchRows(candidate, module.uuid, sourceRows, {
					...env,
					doc: candidate,
				});
				if (
					!match.matched.some(
						(one) =>
							one.source === input.rows.indexOf(row) && one.from === from,
					)
				)
					return undefined;
				const sources = match.matched.map((one) => one.source);
				return sources.every(
					(one, index) => index === 0 || (sources[index - 1] as number) < one,
				);
			};
			// B: a list filter clause restated.
			const clause = listClauses.findIndex(
				(one, index) => !restated.has(index) && sameJson(one, conjunct),
			);
			if (clause !== -1) {
				restated.add(clause);
				record({ kind: "B", clause });
				continue;
			}
			// C: a simple field's derivation.
			const prompt = input.prompts.find(
				(one) =>
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
			if (reads.length > 0) {
				// D: the field's own condition, then a list clause that waits for its fields.
				const ordered = input.prompts.filter((one) =>
					reads.some((read_) => read_.uuid === one.uuid),
				);
				const firstPrompt = ordered[0];
				const candidates: {
					from: "field" | "filter";
					input?: Uuid;
					doc: BlueprintDoc;
				}[] = [];
				if (firstPrompt?.exclude && !derivedInputs.has(firstPrompt.uuid))
					candidates.push({
						from: "field",
						input: firstPrompt.uuid,
						doc: withCandidate(doc, (draft) =>
							setPredicate(
								draft as BlueprintDoc,
								module.uuid,
								firstPrompt.uuid,
								conjunct,
							),
						),
					});
				if (reads.every((one) => one.guarded))
					candidates.push({
						from: "filter",
						doc: withCandidate(doc, (draft) =>
							setFilter(draft as BlueprintDoc, module.uuid, conjunct),
						),
					});
				const passing = candidates.flatMap((candidate) => {
					const match = matchSearchRows(
						candidate.doc,
						module.uuid,
						sourceRows,
						{ ...env, doc: candidate.doc },
					);
					const own = match.matched.find(
						(one) =>
							one.source === input.rows.indexOf(row) &&
							one.from === candidate.from,
					);
					if (own === undefined) return [];
					const sources = match.matched.map((one) => one.source);
					const inOrder = sources.every(
						(one, index) => index === 0 || (sources[index - 1] as number) < one,
					);
					return [{ ...candidate, inOrder }];
				});
				const chosen = passing.find((one) => one.inOrder) ?? passing[0];
				if (chosen !== undefined) {
					doc = chosen.doc;
					record({
						kind: "D",
						from: chosen.from,
						...(chosen.input !== undefined && { input: chosen.input }),
					});
					continue;
				}
				ctx.accounting.finding(ROW_CLAIMS.readsMatchedField, place);
				record({ kind: "E", entry: ROW_CLAIMS.readsMatchedField.entry });
				continue;
			}
			// F: the search's own filter, joined to the list filter.
			if (ownsFilter) {
				doc = withCandidate(doc, (draft) =>
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
			ctx.accounting.finding(ROW_CLAIMS.noSlot, place);
			record({ kind: "E", entry: ROW_CLAIMS.noSlot.entry });
		}
	}

	const unrestated = listClauses.flatMap((_, index) =>
		restated.has(index) ? [] : [index],
	);
	if (unrestated.length > 0) {
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

	// (R2): Nova's emission of the settled menu writes every source row back.
	const settled = matchSearchRows(doc, module.uuid, sourceRows, {
		...env,
		doc,
	});
	const sources = settled.matched.map((one) => one.source);
	const inOrder = sources.every(
		(one, index) => index === 0 || (sources[index - 1] as number) < one,
	);
	const extraAllowed = input.formsReadSearch ? unrestated.length : 0;
	if (settled.unmatched.length > 0 || settled.extra.length > extraAllowed) {
		if (!ctx.accounting.hasFindingAt(place))
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:DefaultCaseSearchProperty.defaultValue",
			});
	} else if (!inOrder || conjuncts.length !== input.rows.length)
		sameState(
			ctx,
			ROWS_HELD,
			`${module.json.pointer}/search_config/default_properties`,
			"search-filter-rows-recut",
		);
	ctx.doc = doc;
	return { conjuncts, unrestated };
}
