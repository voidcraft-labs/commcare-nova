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
import {
	isSilentRuntimeCsqlRejection,
	type RuntimeCsqlRejection,
} from "@/lib/commcare/csql/segment";
import type { CsqlNode } from "@/lib/commcare/csql/tree";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { caseListStepDatumId } from "@/lib/commcare/formLinkProjection";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { getAdvancedArmPredicates } from "@/lib/commcare/suite/case-search/searchPrompts";
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
	isOrdinaryCaseSearchConfig,
	type Module,
	materializableCaseTypes,
	type SearchRuntimeValidationKind,
	searchRuntimeValidationKinds,
	type Uuid,
} from "@/lib/domain";
import { expressionChildren } from "@/lib/domain/expression/children";
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import { csqlRuntimeRoots } from "@/lib/domain/expression/csqlPositions";
import type { Expression, Term } from "@/lib/domain/expression/types";
import { expressionReferencesAnySearchInput } from "@/lib/domain/expression/walk";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import { PreviewXPathRuntimeError } from "../xpath/runtimeError";
import type { XPathInstance } from "../xpath/runtimeValues";
import type { EvalContext, XPathValue } from "../xpath/types";
import { expressionReadsCaseDatabase } from "./expressionCaseReads";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import {
	type SearchInputValues,
	searchInputInstanceValues,
} from "./runtimeBindings";
import type { SearchScreenXPath } from "./searchExpressionEvaluation";
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
 * `refusal` is the kind of a row's obligation that holds first (the device
 * evaluates no later one), when it has no prompt to blame and a message for
 * the worker (06-csql.md §5): the Results read shows
 * its message (`searchRuntimeGlobalValidationMessage`), as it does for one
 * the server judges itself, rather than an empty list. `unevaluated` says
 * Preview's evaluator could not work out what the device sends for some row
 * (a function only the XPath worker's Java engine runs), so the Results read
 * refuses the search rather than answer it without that row.
 */
export interface SearchCsqlRuntimeWire {
	readonly segments: Readonly<Record<string, string>>;
	readonly choices: Readonly<Record<string, boolean>>;
	readonly refusal?: SearchRuntimeValidationKind;
	readonly unevaluated?: true;
}

/** The Results read's answer to a search Preview could not work out. */
export const SEARCH_CSQL_UNEVALUATED_MESSAGE =
	"Preview can't work out a value this search builds on the device, so it can't show what the search finds. On a device or in Web Apps, the search runs as built.";

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

/** Each case list config's answer, by the config's identity: an edit
 * elsewhere in the app leaves every module's config object as it was, so
 * the app-wide requirements walk reads each config once. */
const configReadsCaseDatabase = new WeakMap<CaseListConfig, boolean>();

/**
 * Whether a search's rows hold a runtime piece that reads the device's case
 * snapshot (`expressionCaseReads.ts::expressionReadsCaseDatabase`): its cases,
 * a chosen case's properties, the worker's record. The rows are the filter's
 * and the advanced inputs': a simple input's derived row reads its answer
 * alone. No search row reads a repeat's row (that is a form's), so the
 * answer depends on the config alone and is kept by its identity.
 */
export function searchCsqlReadsCaseDatabase(
	caseListConfig: CaseListConfig,
): boolean {
	const known = configReadsCaseDatabase.get(caseListConfig);
	if (known !== undefined) return known;
	const rows = [
		...(caseListConfig.filter === undefined ? [] : [caseListConfig.filter]),
		...getAdvancedArmPredicates(caseListConfig.searchInputs).map(
			(entry) => entry.predicate,
		),
	];
	const reads = rows.some((row) =>
		csqlRuntimeRoots(row).some((root) =>
			expressionReadsCaseDatabase(root.node),
		),
	);
	configReadsCaseDatabase.set(caseListConfig, reads);
	return reads;
}

/**
 * Whether a module's search waits for the device's cases before it sends:
 * it has a Search (any input, or the ordinary Search settings) and a runtime
 * piece that reads them. The ONE predicate both sides decide from: the case
 * database provider loads the snapshot for such a module
 * (`useCaseDatabaseSnapshot.tsx::caseDatabaseRequirements`), and a
 * submission's values wait for it (`useSearchCsqlRuntime.ts::searchWorld`),
 * so a search never waits on a load nobody requests. Total over every module:
 * the owner-only arm with inputs, which the blueprint schema refuses, reads
 * as a Search here rather than throwing as `effectiveCaseSearchConfig` does.
 */
export function moduleSearchReadsCaseDatabase(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): boolean {
	const config = module.caseListConfig;
	if (config === undefined) return false;
	const hasSearch =
		config.searchInputs.length > 0 ||
		isOrdinaryCaseSearchConfig(module.caseSearchConfig);
	return hasSearch && searchCsqlReadsCaseDatabase(config);
}

/**
 * Where a piece Preview's synchronous evaluator can't run is evaluated: the
 * Search screen's XPath worker, which runs the device's Java Pattern engine
 * (`engineController.ts::evaluateSearchScreenXPath`). It throws for a piece
 * the worker can't run either.
 *
 * It takes no abort signal. Cancelling a worker request terminates the
 * worker (`workerClient.ts`: a synchronous Pattern evaluation can't read a
 * cancel message, so termination is the only way to stop it), and with it
 * every other request the Search screen has in flight. A superseded
 * evaluation instead stops sending pieces and its result is dropped, and the
 * worker stays.
 */
export type SearchCsqlDeviceEvaluator = (
	xpath: SearchScreenXPath,
) => Promise<XPathValue>;

/** The most times one piece is sent while other scopes take the worker. */
const SUPERSEDED_SENDS = 3;

/**
 * `evaluate`, sending a piece again when another scope took the Search
 * screen's worker from under it (`stale`: another module's Search screen
 * asked it something, so `workerClient.ts` started a fresh worker for that
 * one). The piece never ran to an answer, so sending it again asks the
 * device the same question. A search's values are worked out on the session
 * whatever screen shows (`SearchDeviceValuesRecorder.tsx`), so this is how
 * they meet another screen's checks. Any other failure, a timeout among
 * them, is the piece's own, and stands.
 */
export function resendingWhenSuperseded(
	evaluate: SearchCsqlDeviceEvaluator,
	signal?: AbortSignal,
): SearchCsqlDeviceEvaluator {
	return async (xpath) => {
		for (let sends = 1; ; sends += 1) {
			try {
				return await evaluate(xpath);
			} catch (error) {
				if (
					sends >= SUPERSEDED_SENDS ||
					signal?.aborted === true ||
					!(error instanceof PreviewXPathRuntimeError) ||
					error.failure.code !== "stale"
				)
					throw error;
			}
		}
	};
}

/**
 * Evaluate a search's runtime pieces over the Search screen's world, in the
 * order Core evaluates the request. `undefined` when the search has no
 * clause to fold. A clause the emitter cannot write yet (a lookup the held
 * snapshot does not name) contributes nothing, and the server leaves it to
 * the store as authored.
 *
 * Each row is its wrapper, `if(<or of obligations>, 'match-none()',
 * concat(…))`: the obligations first, each in turn until one holds (XPath's
 * `or` stops there), and only when none holds the row's text, where each
 * choice's condition is decided before the one branch it takes. A piece in
 * a branch the device doesn't take, or after an obligation that holds, is
 * never evaluated.
 *
 * Each piece runs in Preview's synchronous evaluator first, which holds
 * every function but the ones only the XPath worker runs (a pattern the
 * author wrote, encryption); those go to `onDevice`, one at a time, each
 * awaited before the next is sent, so each runs under its own full
 * watchdog in the one worker. Without `onDevice` (App Tests' server reads,
 * which hold no Java Pattern engine), or where the worker fails too, the
 * piece has no value and the row is `unevaluated`: nothing more of it is
 * sent. Once `signal` aborts, no further piece goes to the worker.
 */
export async function evaluateSearchCsqlRuntime(
	world: SearchCsqlWorld,
	onDevice?: SearchCsqlDeviceEvaluator,
	signal?: AbortSignal,
): Promise<SearchCsqlRuntimeWire | undefined> {
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
	const instances = searchCsqlInstances(world);
	const context = evalContext(instances);
	const piece = async (wire: WireExpr): Promise<XPathValue | undefined> => {
		const source = serializeWire(wire, { target: "suite" }).text;
		try {
			return evaluate(source, context);
		} catch {
			if (onDevice === undefined || signal?.aborted === true) return undefined;
			try {
				return await onDevice({ source, instances });
			} catch {
				return undefined;
			}
		}
	};
	const segments: Record<string, string> = {};
	const choices: Record<string, boolean> = {};
	let refusal: SearchRuntimeValidationKind | undefined;
	let unevaluated = false;
	for (const [row, clause] of clauses.entries()) {
		let tree: CsqlNode;
		try {
			tree = emitCsqlTree(clause.expression, {
				types: clause.context,
				bindings,
			});
		} catch {
			continue;
		}
		const outcome = await evaluateRow(tree, piece);
		if (outcome.kind === "unevaluated") {
			unevaluated = true;
			continue;
		}
		if (outcome.kind === "rejected") {
			choices[rowKey(row)] = true;
			const { rejection } = outcome;
			if (
				refusal === undefined &&
				!isSilentRuntimeCsqlRejection(rejection.kind) &&
				(rejection.inputNames?.length ?? 0) === 0
			)
				refusal = rejection.kind;
			continue;
		}
		for (const [key, value] of outcome.segments)
			segments[rowKey(row, key)] = value;
		for (const [key, value] of outcome.choices)
			choices[rowKey(row, key)] = value;
	}
	return {
		segments,
		choices,
		...(refusal === undefined ? {} : { refusal }),
		...(unevaluated ? { unevaluated: true as const } : {}),
	};
}

/** One piece's value, or `undefined` where neither evaluator has one. */
type PieceEvaluator = (wire: WireExpr) => Promise<XPathValue | undefined>;

/** What the device sends for one row. */
type RowOutcome =
	| { readonly kind: "unevaluated" }
	| { readonly kind: "rejected"; readonly rejection: RuntimeCsqlRejection }
	| {
			readonly kind: "sent";
			readonly segments: ReadonlyMap<string, string>;
			readonly choices: ReadonlyMap<string, boolean>;
	  };

/**
 * One row as Core evaluates its wrapper. Each obligation is judged as the
 * emitter wrote it, its own guards (the condition that picks its branch,
 * the input's presence) and reads included, so one in a branch not taken
 * holds false on its guard alone. A key the tree reads twice (a row-reading
 * condition printed as it stands and negated) is evaluated once.
 */
async function evaluateRow(
	tree: CsqlNode,
	piece: PieceEvaluator,
): Promise<RowOutcome> {
	for (const rejection of csqlRuntimeRow(tree).rejections) {
		const holds = await piece(rejection.condition);
		if (holds === undefined) return { kind: "unevaluated" };
		if (toBoolean(holds)) return { kind: "rejected", rejection };
	}
	const segments = new Map<string, string>();
	const choices = new Map<string, boolean>();
	const segment = async (key: string, wire: WireExpr): Promise<boolean> => {
		if (segments.has(key)) return true;
		const value = await piece(wire);
		if (value === undefined) return false;
		segments.set(key, xpathToString(value));
		return true;
	};
	const choice = async (
		key: string,
		wire: WireExpr,
	): Promise<boolean | undefined> => {
		const known = choices.get(key);
		if (known !== undefined) return known;
		const value = await piece(wire);
		if (value === undefined) return undefined;
		const taken = toBoolean(value);
		choices.set(key, taken);
		return taken;
	};
	const all = async (nodes: readonly CsqlNode[]): Promise<boolean> => {
		for (const node of nodes) if (!(await visit(node))) return false;
		return true;
	};
	/* Whether every piece the device splices in under `node` has a value. The
	 * first piece without one stops the walk: the row is unevaluated, so
	 * nothing after it is worth sending. */
	const visit = async (node: CsqlNode): Promise<boolean> => {
		switch (node.k) {
			case "cmp":
				return all([node.left, node.right]);
			case "and":
			case "or":
				return all(node.items);
			case "not":
			case "group":
			case "guarded":
				return visit(node.item);
			case "query-call":
			case "value-call":
				return all(node.args);
			case "step":
			case "literal":
			case "number":
				return true;
			case "json-list":
				for (const item of node.items)
					if (
						item.k === "runtime" &&
						!(await segment(item.hole.key, item.hole.print ?? item.hole.value))
					)
						return false;
				return true;
			case "runtime":
				return segment(node.hole.key, node.hole.value);
			case "choice": {
				const taken = await choice(node.key, node.condition);
				if (taken === undefined) return false;
				return visit(taken ? node.then : node.else);
			}
			case "presence": {
				const present = await choice(node.key, {
					k: "call",
					fn: "count",
					args: [node.trigger],
				});
				if (present === undefined) return false;
				return !present || visit(node.clause);
			}
			default: {
				const exhaustive: never = node;
				throw new Error(`Unknown CSQL node ${String(exhaustive)}.`);
			}
		}
	};
	if (!(await visit(tree))) return { kind: "unevaluated" };
	return { kind: "sent", segments, choices };
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
	/** Whether a row still holds a read of what only the device holds (its
	 * cases, chosen cases, places, a query's projection) because no value
	 * arrived for it: the store can't compile one, so the read refuses. */
	readonly unfoldedDeviceRead: boolean;
}

/**
 * The search's rows folded with the device's values: what HQ's search is
 * asked once the device has built the request. `undefined` when the search
 * has no row. `lookupNaming` names the lookup tables the rows read, as the
 * browser's evaluation named them (`world.lookup.naming`), so both sides
 * compose each clause in one context and key its pieces alike.
 */
export function foldSearchCsql(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	caseListConfig: CaseListConfig,
	wire: SearchCsqlRuntimeWire,
	lookupNaming?: LookupWireNaming,
): SearchCsqlQuery | undefined {
	const clauses = searchCsqlClauses(
		doc,
		moduleUuid,
		caseListConfig,
		lookupNaming,
	);
	if (clauses === undefined) return undefined;
	const rows = clauses.map((clause, row) => ({
		readsAnswers: expressionReferencesAnySearchInput(clause.expression),
		folded: foldCsqlRuntime(clause.expression, rowValues(wire, row), {
			types: clause.context,
		}),
	}));
	return {
		unfoldedDeviceRead: rows.some((row) =>
			csqlRuntimeRoots(row.folded).some((root) => readsDeviceData(root.node)),
		),
		query: conjunction(rows.map((row) => row.folded)) ?? { kind: "match-all" },
		authored: conjunction(
			rows.filter((row) => !row.readsAnswers).map((row) => row.folded),
		),
		readsAnswers: rows.some((row) => row.readsAnswers),
	};
}

/**
 * Whether a runtime piece reads what only the device holds: a query over its
 * cases, chosen cases or places, or a projection of one. The chosen case's
 * property is the one projection the store reads itself, from that case's
 * row with its id bound (part 07 §5.1).
 */
function readsDeviceData(node: Expression | Term): boolean {
	if (node.kind === "project" && readChosenCaseProperty(node) !== undefined)
		return false;
	switch (node.kind) {
		case "cases":
		case "selected-cases":
		case "locations":
		case "project":
			return true;
		default:
			return expressionChildren(node).some(
				(child) => child.kind !== "relation" && readsDeviceData(child.value),
			);
	}
}

/** The search of a read keyed by case ids: the case the no-matches form
 * registered, which the device shows by its id (the wire's return frame),
 * not by the search, so no row of the search applies. */
const KEYED_SEARCH_CSQL: SearchCsqlQuery = {
	query: { kind: "match-all" },
	authored: undefined,
	readsAnswers: false,
	unfoldedDeviceRead: false,
};

/**
 * The search rows one Results read compiles: none for a read keyed by case
 * ids (`keyed`), the rows folded with the browser's values otherwise.
 */
export function searchCsqlForRead(args: {
	readonly keyed: boolean;
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly caseListConfig: CaseListConfig;
	readonly wire: SearchCsqlRuntimeWire | undefined;
	readonly lookupNaming?: LookupWireNaming;
}): SearchCsqlQuery | undefined {
	if (args.keyed) return KEYED_SEARCH_CSQL;
	return foldSearchCsql(
		args.doc,
		args.moduleUuid,
		args.caseListConfig,
		args.wire ?? { segments: {}, choices: {} },
		args.lookupNaming,
	);
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
	const { segments, choices, refusal, unevaluated } = value as Record<
		string,
		unknown
	>;
	if (
		!plainRecord(segments, (entry) => typeof entry === "string") ||
		!plainRecord(choices, (entry) => typeof entry === "boolean") ||
		!(refusal === undefined || isSearchRuntimeValidationKind(refusal)) ||
		!(unevaluated === undefined || unevaluated === true)
	)
		throw new SearchCsqlRuntimeError();
	return {
		segments: segments as Record<string, string>,
		choices: choices as Record<string, boolean>,
		...(refusal === undefined ? {} : { refusal }),
		...(unevaluated === true ? { unevaluated } : {}),
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
			"The values this search worked out on the device didn't arrive as text and true-or-false answers keyed by search clause, with at most one known kind of check that failed and an optional mark that a clause couldn't be worked out. Look at what the Search screen sent with the Results read.",
		);
		this.name = "SearchCsqlRuntimeError";
	}
}
