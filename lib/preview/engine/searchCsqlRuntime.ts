// lib/preview/engine/searchCsqlRuntime.ts
//
// What Core works out on the device before a search's `_xpath_query` reaches
// HQ, and the fold that applies it (06-csql.md §4).
//
// Browser side, `evaluateSearchCsqlRuntime` composes the module's search
// clauses as the export does (each in its own slot's context, each case
// chosen before the module's case list step printed under the id the step
// holds), and evaluates, with Preview's XPath evaluator over the Search
// screen's world (the answers, the session with the datums supplied before
// the list, the device's cases, the lookup tables and places), each runtime
// segment's value, each runtime choice's condition and each row's
// obligations. The results cross to the Results Server Action as plain
// objects, never a `Map`, so the call stays a JSON body.
//
// Server side, `foldSearchCsql` folds each row with them
// (`lib/commcare/csql/fold.ts::foldCsqlRuntime`), so the case store compiles
// only what HQ itself reads and no runtime leaf reaches Postgres.
//
// The rows are the case list filter's and the advanced inputs' predicates.
// A simple input's answer reaches the store as the literal it is
// (`runtimeBindings.ts::composeRuntimeFilter`), so no device value of it is
// left to fold.

import { emitCsqlTree } from "@/lib/commcare/csql/emitter";
import {
	type CsqlRuntimeValues,
	csqlRuntimeRow,
	foldCsqlRuntime,
} from "@/lib/commcare/csql/fold";
import { isSilentRuntimeCsqlRejection } from "@/lib/commcare/csql/segment";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { caseListStepDatumId } from "@/lib/commcare/formLinkProjection";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	composeXPathQueryClauses,
	type XPathQueryClause,
} from "@/lib/commcare/suite/case-search/xpathQuery";
import type { SearchInputInstanceId } from "@/lib/commcare/xpath/wire/fromExpression";
import { STANDALONE_SEARCH_INPUT_INSTANCE_ID } from "@/lib/commcare/xpath/wire/instances";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	type BlueprintDoc,
	type CaseListConfig,
	materializableCaseTypes,
	type SearchRuntimeValidationKind,
	searchRuntimeValidationKinds,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { expressionReferencesAnySearchInput } from "@/lib/domain/expression/walk";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { XPathInstance } from "../xpath/runtimeValues";
import type { EvalContext } from "../xpath/types";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import {
	type SearchInputValues,
	searchInputInstanceValues,
} from "./runtimeBindings";
import {
	type CaseDatabaseSnapshot,
	caseDatabaseXPathInstance,
	locationsXPathInstance,
	searchScreenXPathInstances,
} from "./xpathInstances";

/**
 * A search's runtime values on the wire. Keys are `<row>:<segment key>`,
 * the row its index among the composed clauses and the segment key the
 * emitter's (`csqlPositionKey` of the checker path). A row's obligations
 * are its own choice of `match-none()`, keyed by the row alone (`<row>`).
 * `refusal` is the kind of the first obligation that holds with no prompt to
 * blame and a message for the worker (06-csql.md §5): the Results read shows
 * its message (`searchRuntimeGlobalValidationMessage`), as it does for one
 * the server judges itself, rather than an empty list.
 */
export interface SearchCsqlRuntimeWire {
	readonly segments: Readonly<Record<string, string>>;
	readonly choices: Readonly<Record<string, boolean>>;
	readonly refusal?: SearchRuntimeValidationKind;
}

/** What the device holds while it builds the search request. */
export interface SearchCsqlWorld {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly caseListConfig: CaseListConfig;
	/** Every value the search carries, hidden inputs' included. */
	readonly answers: SearchInputValues;
	readonly session: PreviewSearchSessionValues;
	/** The datums supplied before the module's case list step. */
	readonly sessionData?: Readonly<Record<string, string>>;
	readonly caseDatabase: CaseDatabaseSnapshot | null;
	readonly lookup?: PreviewLookupData;
}

function rowKey(row: number, key?: string): string {
	return key === undefined ? `${row}` : `${row}:${key}`;
}

/** The rows the fold covers: the filter's and the advanced inputs'. */
function searchCsqlClauses(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	caseListConfig: CaseListConfig,
	lookupNaming?: LookupWireNaming,
): readonly XPathQueryClause[] | undefined {
	return composeXPathQueryClauses(
		caseListConfig,
		undefined,
		moduleExpressionContexts(doc, moduleUuid, lookupNaming),
	);
}

/**
 * Evaluate a search's runtime pieces over the Search screen's world.
 * `undefined` when the search has no clause to fold. A clause the emitter
 * cannot write yet (a lookup the held snapshot does not name) contributes
 * nothing, and the server leaves it to the store as authored.
 */
export function evaluateSearchCsqlRuntime(
	world: SearchCsqlWorld,
): SearchCsqlRuntimeWire | undefined {
	const clauses = searchCsqlClauses(
		world.doc,
		world.moduleUuid,
		world.caseListConfig,
		world.lookup?.naming,
	);
	if (clauses === undefined) return undefined;
	const bindings = {
		searchInputInstanceId:
			STANDALONE_SEARCH_INPUT_INSTANCE_ID as SearchInputInstanceId,
		datumId: caseListStepDatumId(world.doc, world.moduleUuid),
		...(world.lookup === undefined
			? {}
			: {
					lookup: {
						naming: world.lookup.naming,
						instanceScope: "suite" as const,
					},
				}),
	};
	const context = evalContext(searchCsqlInstances(world));
	/* A read Preview's evaluator cannot run (a function only the XPath
	 * worker's Java engine has) gives no value, and the server leaves its node
	 * to the store as authored. */
	const run = (wire: WireExpr) => {
		try {
			return evaluate(serializeWire(wire, { target: "suite" }).text, context);
		} catch {
			return undefined;
		}
	};
	const segments: Record<string, string> = {};
	const choices: Record<string, boolean> = {};
	let refusal: SearchRuntimeValidationKind | undefined;
	for (const [row, clause] of clauses.entries()) {
		let tree: ReturnType<typeof emitCsqlTree>;
		try {
			tree = emitCsqlTree(clause.expression, {
				types: clause.context,
				bindings,
			});
		} catch {
			continue;
		}
		const { reads, rejections } = csqlRuntimeRow(tree);
		const listItems: string[] = [];
		for (const segment of reads.segments) {
			const value = run(segment.value);
			if (value === undefined) continue;
			const text = xpathToString(value);
			segments[rowKey(row, segment.key)] = text;
			if (segment.listItem) listItems.push(...text.split('","'));
		}
		for (const choice of reads.choices) {
			const value = run(choice.condition);
			if (value !== undefined)
				choices[rowKey(row, choice.key)] = toBoolean(value);
		}
		let rejected = false;
		for (const rejection of rejections) {
			const holds =
				rejection.kind === "list-item"
					? listItems.some(breaksList)
					: (() => {
							const value = run(rejection.condition);
							return value !== undefined && toBoolean(value);
						})();
			if (!holds) continue;
			rejected = true;
			if (
				refusal === undefined &&
				!isSilentRuntimeCsqlRejection(rejection.kind) &&
				(rejection.inputNames?.length ?? 0) === 0
			)
				refusal = rejection.kind;
		}
		if (rejected) choices[rowKey(row)] = true;
	}
	return { segments, choices, ...(refusal === undefined ? {} : { refusal }) };
}

/**
 * Whether a list item's text would break the JSON list or the CSQL literal
 * around it: a double quote, a backslash, an ASCII control character or a
 * single quote. The `list-item` obligation's own condition is Java's
 * `regex(v, '["\\p{Cntrl}]') or contains(v, "'")`, which Preview's
 * evaluator cannot run (`regex` needs the XPath worker), so its meaning is
 * decided here over the same values.
 */
function breaksList(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (
			char === '"' ||
			char === "\\" ||
			char === "'" ||
			code < 0x20 ||
			code === 0x7f
		)
			return true;
	}
	return false;
}

/** The instances the device's query screen evaluates the request in. */
function searchCsqlInstances(
	world: SearchCsqlWorld,
): ReadonlyMap<string, XPathInstance> {
	const instances = new Map(
		searchScreenXPathInstances({
			session: world.session,
			answers: searchInputInstanceValues(
				world.caseListConfig.searchInputs,
				world.answers,
			),
			...(world.lookup === undefined ? {} : { lookupData: world.lookup }),
			...(world.sessionData === undefined
				? {}
				: { sessionData: world.sessionData }),
		}),
	);
	instances.set(
		"casedb",
		caseDatabaseXPathInstance(
			world.caseDatabase,
			materializableCaseTypes(world.doc),
		),
	);
	const locations = world.caseDatabase?.locations;
	if (locations !== undefined)
		instances.set("locations", locationsXPathInstance(locations, world.doc));
	return instances;
}

function evalContext(
	instances: ReadonlyMap<string, XPathInstance>,
): EvalContext {
	return {
		contextPath: "",
		position: 1,
		getValue: () => undefined,
		resolveXPathInstance: (id) => instances.get(id),
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	};
}

/** Each row's values out of the wire. */
function rowValues(
	wire: SearchCsqlRuntimeWire,
	row: number,
): CsqlRuntimeValues {
	const prefix = rowKey(row, "");
	const pick = <T>(record: Readonly<Record<string, T>>) =>
		Object.fromEntries(
			Object.entries(record).flatMap(([key, value]) =>
				key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [],
			),
		) as Record<string, T>;
	return {
		segments: pick(wire.segments),
		choices: pick(wire.choices),
		...(Object.hasOwn(wire.choices, rowKey(row)) &&
		wire.choices[rowKey(row)] === true
			? { rejected: true }
			: {}),
	};
}

/** Whether a row's obligations hold: the exported search finds nothing. */
export function searchCsqlRejected(wire: SearchCsqlRuntimeWire): boolean {
	return Object.entries(wire.choices).some(
		([key, value]) => value && !key.includes(":"),
	);
}

/** A search's `_xpath_query` rows as HQ is asked them, folded. */
export interface SearchCsqlQuery {
	/** Every row, AND-composed. */
	readonly query: Expression;
	/** The rows no answer reaches: what authored rules alone allow. */
	readonly authored: Expression | undefined;
	/** Whether a row reads an answer, so the worker's search narrows it. */
	readonly readsAnswers: boolean;
}

/**
 * The search's rows folded with the device's values: what HQ's search is
 * asked once the device has built the request. `undefined` when the search
 * has no row.
 */
export function foldSearchCsql(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	caseListConfig: CaseListConfig,
	wire: SearchCsqlRuntimeWire,
): SearchCsqlQuery | undefined {
	const clauses = searchCsqlClauses(doc, moduleUuid, caseListConfig);
	if (clauses === undefined) return undefined;
	const rows = clauses.map((clause, row) => ({
		readsAnswers: expressionReferencesAnySearchInput(clause.expression),
		folded: foldCsqlRuntime(clause.expression, rowValues(wire, row), {
			types: clause.context,
		}),
	}));
	return {
		query: conjunction(rows.map((row) => row.folded)) ?? { kind: "match-all" },
		authored: conjunction(
			rows.filter((row) => !row.readsAnswers).map((row) => row.folded),
		),
		readsAnswers: rows.some((row) => row.readsAnswers),
	};
}

function conjunction(clauses: readonly Expression[]): Expression | undefined {
	const [first, second, ...rest] = clauses;
	if (first === undefined) return undefined;
	return second === undefined
		? first
		: { kind: "and", clauses: [first, second, ...rest] };
}

/**
 * A runtime-values bag that crossed the wire, checked for shape: plain
 * objects of strings and booleans. Anything else is refused, never repaired.
 */
export function parseSearchCsqlRuntimeWire(
	value: unknown,
): SearchCsqlRuntimeWire | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null)
		throw new SearchCsqlRuntimeError();
	const { segments, choices, refusal } = value as Record<string, unknown>;
	if (
		!plainRecord(segments, (entry) => typeof entry === "string") ||
		!plainRecord(choices, (entry) => typeof entry === "boolean") ||
		!(refusal === undefined || isSearchRuntimeValidationKind(refusal))
	)
		throw new SearchCsqlRuntimeError();
	return {
		segments: segments as Record<string, string>,
		choices: choices as Record<string, boolean>,
		...(refusal === undefined ? {} : { refusal }),
	};
}

function isSearchRuntimeValidationKind(
	value: unknown,
): value is SearchRuntimeValidationKind {
	return (searchRuntimeValidationKinds as readonly unknown[]).includes(value);
}

function plainRecord(
	value: unknown,
	entryOk: (entry: unknown) => boolean,
): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(entryOk)
	);
}

/** The most menus an entry passes through that a read may name. */
const MAX_CHOSEN_CASES = 64;

/**
 * The chosen cases a browse list's read carries, checked for shape: at most
 * 64 menus, each a module UUID naming one case id of 1 to 255 characters.
 * Each id is a bound parameter fenced by app and Project in the store, so
 * the check guards the request, not the data.
 */
export function parseChosenCaseIds(
	value: unknown,
): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (
		!plainRecord(
			value,
			(entry) =>
				typeof entry === "string" && entry.length > 0 && entry.length <= 255,
		) ||
		Object.keys(value as object).length > MAX_CHOSEN_CASES
	)
		throw new ChosenCaseIdsError();
	return value as Readonly<Record<string, string>>;
}

/** The chosen cases reached the read in a shape Preview never sends. */
export class ChosenCaseIdsError extends Error {
	constructor() {
		super(
			"The cases chosen before this list didn't arrive as one case id per menu. Each needs to be text of 1 to 255 characters, for at most 64 menus. Look at what the case list sent with its read.",
		);
		this.name = "ChosenCaseIdsError";
	}
}

/** The search's device values reached the read in a shape Preview never
 * sends. */
export class SearchCsqlRuntimeError extends Error {
	constructor() {
		super(
			"The values this search worked out on the device didn't arrive as text and true-or-false answers keyed by search clause, with at most one known kind of check that failed. Look at what the Search screen sent with the Results read.",
		);
		this.name = "SearchCsqlRuntimeError";
	}
}
