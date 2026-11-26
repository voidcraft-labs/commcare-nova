/**
 * A search filter row read back: one `_xpath_query` value, on-device XPath
 * whose value at run time is one CSQL string. The wrapper is reduced to CSQL
 * text with holes (`skeleton`), the text is parsed with the one grammar, its
 * tree bound to the record arms (`bindCsql`), and the candidate is held only
 * where the production CSQL emitter writes the source back: the same wrapper
 * (exact), or the same CSQL and the same device values with only Nova's
 * guards and quote choice around them (`search-value-guards`). Nothing here
 * matches text: the print proves every recognition.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import {
	activeRowScope,
	type ExpressionContext,
	type LookupDefinitionIndex,
	pushRowScope,
} from "@/lib/domain/expression/context";
import {
	csqlPositionAt,
	csqlPositions,
} from "@/lib/domain/expression/csqlPositions";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import {
	searchIndexedComparison,
	searchIndexedValueKind,
} from "@/lib/domain/expression/searchIndexedComparison";
import {
	type CheckError,
	checkExpression,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import {
	COMPARISON_KINDS,
	type ComparisonKind,
	DATE_ADD_INTERVALS,
	type DateAddInterval,
	type Expression,
	isConditionArm,
	type Literal,
	type PropertyRef,
	type RelationStep,
	type SearchInputRef,
	type Term,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { effectiveCaseSearchConfig } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import type { FindingDetail } from "@/lib/publish/hqFindings";
import { RESERVED_CASE_ATTRIBUTES } from "../../casePropertyWire";
import {
	type CsqlEmissionContext,
	emitCsql,
	emitCsqlTree,
} from "../../csql/emitter";
import { csqlClauseWrapper, printCsql } from "../../csql/print";
import { checkCsqlRepresentability } from "../../csql/representability";
import type { CsqlNode } from "../../csql/tree";
import {
	EMISSION_REWRITE_IDS,
	EMISSION_REWRITES,
	type EmissionRewriteId,
} from "../../emissionRewrites";
import { caseListStepDatumId } from "../../formLinkProjection";
import { parseHqJsonText } from "../../hq/jsonText";
import { lookupWireNaming } from "../../lookup/naming";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { searchWireShape } from "../../suite/case-search/searchWireShape";
import {
	inlineSearchInstance,
	searchInputInstanceId,
} from "../../suite/case-search/types";
import { rethrowWorkStop } from "../../workMeter";
import { type FormSyntax, literalInstanceId } from "../../xpath/formSyntax";
import {
	CSQL_QUERY_FUNCTIONS,
	CSQL_VALUE_FUNCTIONS,
} from "../../xpath/functionCapabilities";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { sameJson } from "../jsonCursor";
import type { PendingExpression } from "../pendingExpressions";
import { firstDifference, sameSyntax } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { switchOfIfChain, typedRelations } from "./canonical";
import {
	agreedComparedTypes,
	type ComparedType,
	comparedTypes,
	withPropertyTypes,
} from "./comparedTypes";
import {
	checkErrorEntry,
	claimKey,
	EXPRESSION_CLAIMS,
	parseIssueEntry,
	visitSyntax,
} from "./findings";
import { shapedLiteral } from "./folds";
import type { ExpressionReadEnv } from "./index";
import { bindSlot } from "./readExpression";
import { typedWhereRequired } from "./temporalLiterals";

export type SearchRowReading =
	| {
			readonly ok: true;
			readonly predicate: Expression;
			readonly level: "exact" | "guards";
			readonly rewrites: readonly EmissionRewriteId[];
			/** The types the row's comparisons give properties its catalog
			 *  holds untyped, which the predicate is read and checked under. */
			readonly types?: readonly ComparedType[];
			/** The row names a selection by a spelling HQ's search reads as the one Nova
			 *  prints (`hqSelectionSpelling`), which the first publish writes in its place. */
			readonly respelled?: true;
	  }
	| {
			readonly ok: false;
			readonly claim: {
				readonly entryId: string;
				/** The surface key the entry is answered under: the operator,
				 *  function or metadata name of the row a member of the entry is
				 *  registered under, else the entry's own key. */
				readonly key: string;
				readonly detail: FindingDetail;
			};
	  }
	| {
			readonly ok: false;
			readonly unrecognized: true;
			/** `differs:<kind>`, the kind of the source node at which the row's
			 *  wrapper first differs from Nova's own wrapper of its reading (the
			 *  wrapper's own node where nothing bound), or `parse:syntax` where
			 *  the grammar reads no wrapper. */
			readonly reason: string;
	  };

export interface SearchRowEnv {
	readonly doc: BlueprintDoc;
	readonly lookup: LookupDefinitionIndex;
}

const C = EXPRESSION_CLAIMS;
const RUNTIME_NAMES =
	C["property-names-operators-or-function-names-computed-at-runtime"].entry;
const UNPARENTHESIZED =
	C["a-function-call-written-unparenthesized-as-the-2nd-or-later"].entry;
const HQ_REFUSES =
	C["a-function-on-the-left-side-a-property-on-the-right-side"].entry;
const DEVICE_QUERY =
	C["a-search-value-that-queries-cases-a-table-or-places"].entry;
const M7 = C["xpath-query-condition-nova-s-checker-refuses"].entry;
const UNTYPED_RIGHT_SIDE =
	C["p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of@csql-op:>"]
		.entry;

// ── The skeleton ─────────────────────────────────────────────────────

type SkeletonPart =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "hole";
			readonly node: FormSyntax;
			readonly quoted: boolean;
	  }
	| {
			readonly kind: "presence";
			readonly input: FormSyntax;
			readonly body: readonly SkeletonPart[];
			/** The conditions the body's own wrapper sends `match-none()` under. */
			readonly rejects: readonly FormSyntax[];
	  }
	| {
			readonly kind: "choice";
			readonly condition: FormSyntax;
			readonly then: readonly SkeletonPart[];
			readonly otherwise: readonly SkeletonPart[];
			/** The whole `if(…)`, which the guards level compares as one device value. */
			readonly node: FormSyntax;
	  };

/** A node without the parentheses around it. */
function bare(node: FormSyntax): FormSyntax {
	return node.kind === "group" ? bare(node.value) : node;
}

/** A node without one pair of parentheses around it. */
function unparenthesized(node: FormSyntax): FormSyntax {
	return node.kind === "group" ? node.value : node;
}

function callOf(
	node: FormSyntax,
	name: string,
	arity: number,
): Extract<FormSyntax, { kind: "call" }> | undefined {
	const at = bare(node);
	return at.kind === "call" && at.name === name && at.args.length === arity
		? at
		: undefined;
}

function stringOf(node: FormSyntax | undefined): string | undefined {
	if (node === undefined) return undefined;
	const at = bare(node);
	return at.kind === "string" ? at.value : undefined;
}

function sameNode(a: FormSyntax, b: FormSyntax): boolean {
	return sameSyntax(a, b, { ruleSet: "record" });
}

/** `if(number(V) = 0, 0, V)`: V. A bare bound's device value is spliced in
 *  under that choice, which writes every zero as the bare `0` CSQL reads
 *  (`csql/emitter.ts::subcaseCountBound`); the binding's print says
 *  whether Nova writes it so. */
function bareZeroBound(node: FormSyntax): FormSyntax | undefined {
	const choice = callOf(node, "if", 3);
	if (choice === undefined) return undefined;
	const [condition, zero, value] = choice.args as [
		FormSyntax,
		FormSyntax,
		FormSyntax,
	];
	const test = bare(condition);
	if (test.kind !== "binary" || test.op !== "=") return undefined;
	const number = callOf(test.left, "number", 1);
	const right = bare(test.right);
	const literal = bare(zero);
	if (
		number === undefined ||
		right.kind !== "number" ||
		right.value !== 0 ||
		literal.kind !== "number" ||
		literal.value !== 0 ||
		!sameNode(number.args[0] as FormSyntax, value)
	)
		return undefined;
	return value;
}

/** `contains(V, '<mark>')`, as the quote cascade spells it: V. */
function containsQuote(node: FormSyntax, mark: string): FormSyntax | undefined {
	const test = callOf(node, "contains", 2);
	if (test === undefined) return undefined;
	return stringOf(test.args[1]) === mark ? test.args[0] : undefined;
}

/** A search answer read, `instance('search-input:…')/input/field[…]`: the path's root call names a search-input instance. */
function readsSearchAnswer(node: FormSyntax): boolean {
	let at = bare(node);
	for (;;) {
		if (at.kind === "child" && at.left !== undefined) at = bare(at.left);
		else if (at.kind === "filter") at = bare(at.base);
		else break;
	}
	return literalInstanceId(at)?.value.startsWith("search-input") === true;
}

/** A search row's wrapper over its syntax tree: its parts, and the
 *  conditions under which the whole row sends `match-none()`, which the
 *  guards level holds to the obligations Nova's own wrapper rejects under. */
interface RowSkeleton {
	readonly parts: readonly SkeletonPart[];
	readonly rejects: readonly FormSyntax[];
}

/** A row's skeleton, read one of two ways. `failClosed`: an
 *  `if(G, 'match-none()', X)` at the root of a wrapper fails the row closed
 *  under `G`, which the guards level judges as Nova's own guard. Otherwise
 *  that `if` is a choice like any other, the author's own condition, which
 *  the row's reading holds in its tree. */
function rowSkeleton(wrapper: FormSyntax, failClosed = true): RowSkeleton {
	const rejects: FormSyntax[] = [];
	return {
		parts: skeleton(wrapper, failClosed ? { rejects } : {}),
		rejects,
	};
}

/** Whether a row's wrapper, read as failing closed, fails closed anywhere:
 *  at its root or at the root of its presence body. */
function failsClosed(row: RowSkeleton): boolean {
	return (
		row.rejects.length > 0 ||
		row.parts.some(
			(part) => part.kind === "presence" && part.rejects.length > 0,
		)
	);
}

/** The skeletons a row is read under, the failing-closed one first: where
 *  it fails closed under a condition that is no guard of Nova's, the row is
 *  read again with that condition as a choice. */
function rowSkeletons(wrapper: FormSyntax): readonly RowSkeleton[] {
	const row = rowSkeleton(wrapper);
	return failsClosed(row) ? [row, rowSkeleton(wrapper, false)] : [row];
}

/** The parts of a search row's wrapper, over its syntax tree: the
 *  constant text the wrapper builds, the values the device splices in, and
 *  the choices it makes. `root` is given at the root of a wrapper, where a
 *  presence test is the row's, and where, when `root.rejects` is given, an
 *  `if(G, 'match-none()', X)` fails the whole row closed under `G`: the part
 *  is `X`'s, and `G` is collected for the guards level to judge, never
 *  dropped. Anywhere else such an `if` is a choice like any other. */
function skeleton(
	wrapper: FormSyntax,
	root?: { readonly rejects?: FormSyntax[] },
): readonly SkeletonPart[] {
	const node = bare(wrapper);
	if (node.kind === "string") return [{ kind: "text", text: node.value }];
	if (node.kind === "call" && node.name === "concat")
		return node.args.flatMap((arg) => skeleton(arg));
	const choice = callOf(node, "if", 3);
	if (choice !== undefined) {
		const [condition, thenArg, elseArg] = choice.args as [
			FormSyntax,
			FormSyntax,
			FormSyntax,
		];
		const count = callOf(condition, "count", 1);
		if (
			root !== undefined &&
			count !== undefined &&
			readsSearchAnswer(count.args[0] as FormSyntax) &&
			stringOf(elseArg) === "match-all()"
		) {
			const own: FormSyntax[] = [];
			return [
				{
					kind: "presence",
					input: count.args[0] as FormSyntax,
					body: skeleton(
						thenArg,
						root.rejects === undefined ? {} : { rejects: own },
					),
					rejects: own,
				},
			];
		}
		if (root?.rejects !== undefined && stringOf(thenArg) === "match-none()") {
			root.rejects.push(condition);
			return skeleton(elseArg, root);
		}
		const quoted = containsQuote(condition, '"');
		if (quoted !== undefined) {
			const inner = callOf(thenArg, "if", 3);
			const single =
				inner === undefined
					? undefined
					: containsQuote(inner.args[0] as FormSyntax, "'");
			if (
				inner !== undefined &&
				single !== undefined &&
				sameNode(single, quoted) &&
				stringOf(inner.args[1]) === "match-none()" &&
				sameCascadeBranches(inner.args[2] as FormSyntax, elseArg, quoted)
			)
				return around(elseArg, quoted);
			const singleQuoted = callOf(thenArg, "concat", 3);
			const doubleQuoted = callOf(elseArg, "concat", 3);
			if (
				singleQuoted !== undefined &&
				doubleQuoted !== undefined &&
				stringOf(singleQuoted.args[0]) === "'" &&
				stringOf(singleQuoted.args[2]) === "'" &&
				stringOf(doubleQuoted.args[0]) === '"' &&
				stringOf(doubleQuoted.args[2]) === '"' &&
				sameNode(singleQuoted.args[1] as FormSyntax, quoted) &&
				sameNode(doubleQuoted.args[1] as FormSyntax, quoted)
			)
				return [{ kind: "hole", node: quoted, quoted: true }];
		}
		return [
			{
				kind: "choice",
				condition,
				// biome-ignore lint/suspicious/noThenProperty: a skeleton branch, never awaited.
				then: skeleton(thenArg),
				otherwise: skeleton(elseArg),
				node,
			},
		];
	}
	return [{ kind: "hole", node, quoted: false }];
}

/** Whether a quote cascade's single-quoted branch is its double-quoted one
 *  with the value between the other quote marks: the one CSQL whichever
 *  branch the device takes, so the cascade's parts are the double-quoted
 *  branch's alone. A branch that says something else is no cascade, and its
 *  `if` is read as a choice. */
function sameCascadeBranches(
	single: FormSyntax,
	double: FormSyntax,
	value: FormSyntax,
): boolean {
	const singleParts = around(single, value);
	const doubleParts = around(double, value);
	const prefix = markerPrefix([
		...constantTexts(singleParts),
		...constantTexts(doubleParts),
	]);
	const left = assemble(singleParts, prefix);
	const right = assemble(doubleParts, prefix);
	if (
		left.markers.length !== right.markers.length ||
		left.markers.some(
			({ part }, index) =>
				!sameNode(part.node, right.markers[index]?.part.node as FormSyntax),
		)
	)
		return false;
	const leftCsql = readFormSyntax(left.text);
	const rightCsql = readFormSyntax(right.text);
	return (
		leftCsql.ok &&
		rightCsql.ok &&
		leftCsql.node !== undefined &&
		rightCsql.node !== undefined &&
		sameNode(leftCsql.node, rightCsql.node)
	);
}

/** The skeleton of the double-quoted branch of a quote cascade: its text,
 *  with each argument that is the cascade's value as a hole between the
 *  quote marks the text already holds, whatever the value's own shape. */
function around(
	branch: FormSyntax,
	value: FormSyntax,
): readonly SkeletonPart[] {
	if (sameNode(branch, value))
		return [{ kind: "hole", node: value, quoted: false }];
	const node = bare(branch);
	if (node.kind === "call" && node.name === "concat")
		return node.args.flatMap((arg) =>
			sameNode(arg, value)
				? [{ kind: "hole" as const, node: value, quoted: false }]
				: skeleton(arg),
		);
	return skeleton(branch);
}

/** Each run of text and holes as one CSQL text, a hole or a choice as a
 *  marker: `__nova_hole_<n>__` with as many extra leading underscores as it
 *  takes for no constant text to contain it, so it lexes as a name outside a
 *  string and is a substring inside one. */
interface Assembled {
	readonly text: string;
	/** Each marker, in order, with the part it stands for. */
	readonly markers: readonly {
		readonly marker: string;
		readonly part: Extract<SkeletonPart, { kind: "hole" | "choice" }>;
	}[];
}

function markerPrefix(texts: readonly string[]): string {
	let prefix = "__";
	while (texts.some((text) => text.includes(`${prefix}nova_hole_`)))
		prefix += "_";
	return prefix;
}

function constantTexts(parts: readonly SkeletonPart[]): string[] {
	return parts.flatMap((part) => {
		if (part.kind === "text") return [part.text];
		if (part.kind === "presence") return constantTexts(part.body);
		if (part.kind === "choice")
			return [...constantTexts(part.then), ...constantTexts(part.otherwise)];
		return [];
	});
}

function assemble(parts: readonly SkeletonPart[], prefix: string): Assembled {
	let text = "";
	const markers: {
		marker: string;
		part: Extract<SkeletonPart, { kind: "hole" | "choice" }>;
	}[] = [];
	for (const part of parts) {
		if (part.kind === "text") {
			text += part.text;
			continue;
		}
		if (part.kind === "presence") continue;
		const marker = `${prefix}nova_hole_${markers.length}__`;
		markers.push({ marker, part });
		text += part.kind === "hole" && part.quoted ? `"${marker}"` : marker;
	}
	return { text, markers };
}

// ── Binding CSQL ─────────────────────────────────────────────────────

type Refusal = {
	readonly entryId: string;
	readonly detail: FindingDetail;
	/** The surface key the refusal is about, where the binder knows it. */
	readonly key?: string;
};
type Bound = Expression | Refusal | { readonly unrecognized: true };

class Stop {
	constructor(readonly outcome: Refusal | { readonly unrecognized: true }) {}
}
function refuseWith(entryId: string, reason: string, key?: string): never {
	throw new Stop({
		entryId,
		detail: { name: "_xpath_query", reason },
		...(key === undefined ? {} : { key }),
	});
}
function unrecognizedRow(): never {
	throw new Stop({ unrecognized: true });
}

/** What binding one row needs beyond its parts. */
interface BindState {
	readonly context: ExpressionContext;
	readonly env: SearchRowEnv;
	/** The row's text, which a device node's span indexes. */
	readonly text: string;
	readonly prefix: string;
	/** Proposals the binder may make before the plain reading: `p = ''` as
	 *  `is-blank`, a not of a relation function as `missing`, a closed range on
	 *  a date and time as `eq`, a literal's tokens as several choices, a
	 *  parenthesized join of selection tests or of equalities as the one
	 *  selection or membership Nova prints so. */
	readonly proposals: boolean;
	/** The device values bound to a value that reads a lookup table's row. */
	readonly tableReads: Set<FormSyntax>;
}

const COMPARISONS: SourceTable<ComparisonKind> = tableOf({
	"=": "eq",
	"!=": "neq",
	">": "gt",
	">=": "gte",
	"<": "lt",
	"<=": "lte",
});
const ORDERINGS: ReadonlySet<string> = new Set([">", ">=", "<", "<="]);
const MATCH_MODES: SourceTable<Extract<Expression, { kind: "match" }>["mode"]> =
	tableOf({
		"starts-with": "starts-with",
		"fuzzy-match": "fuzzy",
		"phonetic-match": "phonetic",
		"fuzzy-date": "fuzzy-date",
	});

/** Whether HQ orders by a text: a number `float()` reads, or a date or a
 *  date and time its parsers read. */
function orderable(text: string): boolean {
	return searchIndexedValueKind(text) !== undefined;
}

function term(value: Term): Expression {
	return { kind: "term", term: value };
}

/** The case type of the row the query reads at its top. */
function rowCaseType(context: ExpressionContext): string | undefined {
	const row = activeRowScope(context);
	return row?.kind === "case"
		? row.caseType
		: row?.kind === "table"
			? row.capturedCase?.caseType
			: undefined;
}

/** The types the catalog says a relation from `origin` reaches. */
function relationDestination(
	doc: BlueprintDoc,
	origin: string | undefined,
	via:
		| { readonly kind: "ancestor"; readonly steps: readonly string[] }
		| {
				readonly kind: "subcase";
				readonly identifier: string;
		  },
): string | undefined {
	const types = effectiveCaseTypes(doc);
	if (via.kind === "ancestor") {
		let current = origin;
		for (const step of via.steps) {
			if (step !== "parent" || current === undefined) return undefined;
			current = types.find((type) => type.name === current)?.parent_type;
		}
		return current;
	}
	if (via.identifier !== "parent" || origin === undefined) return undefined;
	const children = types.filter((type) => type.parent_type === origin);
	return children.length === 1 ? children[0]?.name : undefined;
}

/** A marker name: a hole or a choice standing where the text holds it. */
function markerAt(
	node: FormSyntax,
	markers: ReadonlyMap<string, Assembled["markers"][number]["part"]>,
): Assembled["markers"][number]["part"] | undefined {
	const at = bare(node);
	return at.kind === "name" ? markers.get(at.name) : undefined;
}

function holdsMarker(text: string, prefix: string): boolean {
	return text.includes(`${prefix}nova_hole_`);
}

/** Every function call of a CSQL tree at an argument after the first,
 *  written without parentheses: HQ's lexer reads its name as a path step. */
function unparenthesizedCall(node: FormSyntax): boolean {
	let found = false;
	const visit = (at: FormSyntax): void => {
		switch (at.kind) {
			case "call":
				at.args.forEach((arg, index) => {
					if (index > 0 && arg.kind === "call") found = true;
					visit(arg);
				});
				return;
			case "group":
			case "negative":
			case "axis":
				visit(at.value);
				return;
			case "binary":
				visit(at.left);
				visit(at.right);
				return;
			case "child":
				if (at.left !== undefined) visit(at.left);
				visit(at.step);
				return;
			case "filter":
				visit(at.base);
				visit(at.where);
				return;
			default:
				return;
		}
	};
	visit(node);
	return found;
}

/** The parts of the device's own XPath bound under the row's context: the
 *  bind `readExpression` makes, over the node's own text, with no form's
 *  maps and no interpolation. */
function bindDevice(node: FormSyntax, state: BindState): Expression {
	const pending: PendingExpression = {
		ref: state.context.slot,
		text: state.text.slice(node.from, node.to),
		mode: { target: "hq-json", interpolation: "none" },
		place: { kind: "app" },
		key: "csql-key:_xpath_query",
	};
	const bound = bindSlot(
		state.env.doc,
		pending,
		deviceEnv(state.env),
		new Set(),
	);
	if (bound.kind === "refused") {
		const cause = bound.cause;
		if (cause.kind === "parse" && cause.issues[0] !== undefined) {
			const answer = parseIssueEntry(cause.issues[0], state.env.doc, pending);
			if (answer.entryId === "unrecognized") unrecognizedRow();
			refuseWith(
				answer.entryId === "slot-default" ? M7 : answer.entryId,
				answer.reason,
			);
		}
		unrecognizedRow();
	}
	// A row prints a number it holds as server text; one the device works out
	// is the negation of a number only, the value Nova splices in for it.
	const negated = bare(node);
	const value: Expression =
		negated.kind === "negative" && bare(negated.value).kind === "number"
			? {
					kind: "negate",
					value: {
						kind: "term",
						term: {
							kind: "literal",
							value: (bare(negated.value) as { value: number }).value,
						},
					},
				}
			: bound.bound.candidate;
	const query = deviceQuery(value);
	if (query !== undefined) refuseWith(DEVICE_QUERY, query);
	if (readsTableRow(value)) state.tableReads.add(node);
	return value;
}

/** Whether a device value reads a lookup table's row. Nova's Search writes
 *  such a value, so it is held where it prints back; where it alone does
 *  not, the row is the device query the entry refuses
 *  (`readSearchFilterRow`). */
function readsTableRow(value: Expression): boolean {
	let found = false;
	walkExpression(value, {
		visitExpression(expression) {
			if (expression.kind === "table-lookup") found = true;
		},
	});
	return found;
}

/** The device-data query a value holds, other than the chosen case's property. */
function deviceQuery(value: Expression): string | undefined {
	let found: string | undefined;
	// The query a chosen case's property reads through is that read's own.
	const chosen = new Set<Expression>();
	walkExpression(value, {
		visitExpression(expression) {
			if (found !== undefined || chosen.has(expression)) return;
			if (expression.kind === "project") {
				if (readChosenCaseProperty(expression) !== undefined) {
					chosen.add(expression.of);
					return;
				}
				found = "project";
				return;
			}
			if (
				expression.kind === "cases" ||
				expression.kind === "table-rows" ||
				expression.kind === "locations"
			)
				found = expression.kind;
		},
	});
	return found;
}

const deviceEnvs = new WeakMap<SearchRowEnv, ExpressionReadEnv>();
function deviceEnv(env: SearchRowEnv): ExpressionReadEnv {
	let made = deviceEnvs.get(env);
	if (made === undefined) {
		made = {
			lookup: env.lookup,
			sourceNames: new Map(),
			itextUnits: new Map(),
			instanceSources: new Map(),
			factories: {
				namedResults: new Set(
					Object.values(env.doc.modules).flatMap((menu) =>
						menu.searchResultsName === undefined
							? []
							: [inlineSearchInstance(menu.searchResultsName)],
					),
				),
				scrubbedReportSlugs: new Set(),
			},
			generatedValues: new Map(),
			operationIdPaths: new Map(),
			recordDialect: () => undefined,
			entryFactsRefused: new Set(),
			formPlaces: new Map(),
			computedDatums: new Map(),
			rowValues: true,
		};
		deviceEnvs.set(env, made);
	}
	return made;
}

/** One bound CSQL tree. */
class CsqlBinder {
	constructor(
		readonly state: BindState,
		readonly markers: ReadonlyMap<string, Assembled["markers"][number]["part"]>,
	) {}

	query(node: FormSyntax, rowType: string | undefined): Expression {
		const joined = this.parenthesizedJoin(node, rowType);
		if (joined !== undefined) return joined;
		const at = bare(node);
		const choice = markerAt(at, this.markers);
		if (choice !== undefined) {
			if (choice.kind !== "choice")
				refuseWith(RUNTIME_NAMES, "csql:hole-as-query");
			return this.choice(choice, rowType);
		}
		switch (at.kind) {
			case "binary": {
				const choice = this.rowChoice(at, rowType);
				if (choice !== undefined) return choice;
				if (at.op === "and" || at.op === "or") {
					const range = this.proposedEquality(at, rowType);
					if (range !== undefined) return range;
					const clauses = this.flatten(at, at.op).map((clause) =>
						this.query(clause, rowType),
					);
					return {
						kind: at.op,
						clauses: clauses as [Expression, ...Expression[]],
					};
				}
				const kind = COMPARISONS.get(at.op);
				if (kind === undefined)
					refuseWith(HQ_REFUSES, `csql:operator:${at.op}`);
				return this.comparison(kind, at.op, at.left, at.right, rowType);
			}
			case "call":
				return this.queryCall(at, rowType);
			case "name":
			case "child":
			case "axis":
				// A step with no operator.
				refuseWith(HQ_REFUSES, "csql:bare-step");
				break;
			case "variable":
				refuseWith(HQ_REFUSES, "csql:variable");
				break;
			default:
				refuseWith(HQ_REFUSES, `csql:${at.kind}`);
		}
	}

	/** A parenthesized join Nova prints for one Nova node, proposed as that
	 *  node: an `or` of `selected` and `selected-any` tests of one property,
	 *  or an `and` of `selected` and `selected-all` tests, is the one
	 *  selection of those values (`csql/emitter.ts::selection`), and an `or`
	 *  of equalities of one property with fixed values is its membership
	 *  (`::membership`). */
	parenthesizedJoin(
		node: FormSyntax,
		rowType: string | undefined,
	): Expression | undefined {
		if (!this.state.proposals || node.kind !== "group") return undefined;
		const at = bare(node);
		if (at.kind !== "binary" || (at.op !== "or" && at.op !== "and"))
			return undefined;
		const clauses = this.flatten(at, at.op);
		if (at.op === "or")
			return (
				this.selectionJoin(clauses, at.op, rowType) ??
				this.membershipJoin(clauses, rowType)
			);
		// A date and time's equality prints as the range from its value to
		// itself, which is read as the equality.
		return (
			this.selectionJoin(clauses, at.op, rowType) ??
			this.proposedEquality(at, rowType) ??
			this.rangeJoin(clauses, rowType)
		);
	}

	/** A parenthesized `and` of a lower bound's comparison then an upper
	 *  bound's of one operand, which a range prints (`csql/emitter.ts`,
	 *  `between`), proposed as that range. */
	rangeJoin(
		clauses: readonly FormSyntax[],
		rowType: string | undefined,
	): Expression | undefined {
		const [first, second, ...more] = clauses;
		if (first === undefined || second === undefined || more.length > 0)
			return undefined;
		const lowerAt = bare(first);
		const upperAt = bare(second);
		if (
			lowerAt.kind !== "binary" ||
			upperAt.kind !== "binary" ||
			(lowerAt.op !== ">=" && lowerAt.op !== ">") ||
			(upperAt.op !== "<=" && upperAt.op !== "<")
		)
			return undefined;
		const lower = this.query(first, rowType);
		const upper = this.query(second, rowType);
		if (
			(lower.kind !== "gte" && lower.kind !== "gt") ||
			(upper.kind !== "lte" && upper.kind !== "lt") ||
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

	selectionJoin(
		clauses: readonly FormSyntax[],
		op: "or" | "and",
		rowType: string | undefined,
	): Expression | undefined {
		const own = op === "or" ? "selected-any" : "selected-all";
		const tests: Extract<Expression, { kind: "multi-select-contains" }>[] = [];
		for (const clause of clauses) {
			const call = bare(clause);
			if (
				call.kind !== "call" ||
				(call.name !== "selected" && call.name !== own)
			)
				return undefined;
			const test = this.selection(call.name, call.args, rowType);
			const first = tests[0];
			if (
				test.kind !== "multi-select-contains" ||
				test.values.length !== 1 ||
				(first !== undefined && !sameJson(first.property, test.property))
			)
				return undefined;
			tests.push(test);
		}
		const [first, ...rest] = tests;
		if (first === undefined) return undefined;
		return {
			kind: "multi-select-contains",
			property: first.property,
			values: [
				...first.values,
				...rest.flatMap((test) => test.values),
			] as typeof first.values,
			quantifier: op === "or" ? "any" : "all",
		};
	}

	membershipJoin(
		clauses: readonly FormSyntax[],
		rowType: string | undefined,
	): Expression | undefined {
		const values: Literal[] = [];
		let left: Expression | undefined;
		for (const clause of clauses) {
			const at = bare(clause);
			// A date-and-time property's equality prints as the range from the
			// value to itself (`csql/emitter.ts::instantEquality`).
			const equality =
				at.kind === "binary" && at.op === "="
					? this.query(clause, rowType)
					: at.kind === "binary"
						? this.proposedEquality(at, rowType)
						: undefined;
			if (equality === undefined) return undefined;
			if (equality.kind !== "eq") return undefined;
			const value =
				equality.right.kind === "term" ? equality.right.term : undefined;
			if (
				value?.kind !== "literal" ||
				(left !== undefined && !sameJson(left, equality.left))
			)
				return undefined;
			left = equality.left;
			values.push(value);
		}
		const [first, ...rest] = values;
		return left === undefined || first === undefined
			? undefined
			: { kind: "in", left, values: [first, ...rest] };
	}

	/** HQ's own choice between clauses on a condition that reads the case,
	 *  `((c) and (A)) or (not(c) and (B))` (`csql/emitter.ts::conditionChoice`),
	 *  as the `if` it prints. */
	rowChoice(
		node: Extract<FormSyntax, { kind: "binary" }>,
		rowType: string | undefined,
	): Expression | undefined {
		if (!this.state.proposals || node.op !== "or") return undefined;
		const whenTrue = node.left.kind === "group" ? bare(node.left) : undefined;
		const whenFalse =
			node.right.kind === "group" ? bare(node.right) : undefined;
		if (
			whenTrue?.kind !== "binary" ||
			whenTrue.op !== "and" ||
			whenFalse?.kind !== "binary" ||
			whenFalse.op !== "and" ||
			whenTrue.left.kind !== "group" ||
			whenTrue.right.kind !== "group" ||
			whenFalse.right.kind !== "group"
		)
			return undefined;
		const negated = callOf(whenFalse.left, "not", 1);
		const condition = whenTrue.left.value;
		if (negated === undefined) return undefined;
		// A device value the condition holds stands at a marker of its own
		// in each copy, so two copies that differ in their markers alone are
		// one condition where they bind alike.
		const cond = this.query(condition, rowType);
		if (
			!sameNode(negated.args[0] as FormSyntax, condition) &&
			!sameJson(this.query(negated.args[0] as FormSyntax, rowType), cond)
		)
			return undefined;
		return switchOfIfChain({
			kind: "if",
			cond,
			// biome-ignore lint/suspicious/noThenProperty: an expression branch, never awaited.
			then: this.query(whenTrue.right.value, rowType),
			else: this.query(whenFalse.right.value, rowType),
		});
	}

	/** `a and b and c` as the three clauses Nova's printer joins it from. */
	flatten(node: FormSyntax, op: string): FormSyntax[] {
		if (node.kind === "binary" && node.op === op)
			return [...this.flatten(node.left, op), ...this.flatten(node.right, op)];
		return [node];
	}

	choice(
		part: Extract<SkeletonPart, { kind: "choice" }>,
		rowType: string | undefined,
	): Expression {
		const thenQuery = this.parts(part.then, rowType);
		const otherwise = this.parts(part.otherwise, rowType);
		const count = callOf(part.condition, "count", 1);
		if (
			count !== undefined &&
			otherwise.kind === "match-all" &&
			readsSearchAnswer(count.args[0] as FormSyntax)
		) {
			const input = bindDevice(count.args[0] as FormSyntax, this.state);
			if (input.kind === "term" && input.term.kind === "input")
				return {
					kind: "when-input-present",
					input: input.term,
					clause: thenQuery,
				};
		}
		const condition = bindDevice(part.condition, this.state);
		// A clause that reads no case is the device's whole choice of all cases
		// or none (`csql/emitter.ts::runtimeClause`): that condition itself.
		if (
			thenQuery.kind === "match-all" &&
			otherwise.kind === "match-none" &&
			(isConditionArm(condition) ||
				condition.kind === "if" ||
				condition.kind === "switch")
		)
			return condition;
		// A chain of the device's choices on one subject is the `switch` it
		// prints, as a chain HQ's own choices make is.
		return switchOfIfChain({
			kind: "if",
			cond: condition,
			// biome-ignore lint/suspicious/noThenProperty: an expression branch, never awaited.
			then: thenQuery,
			else: otherwise,
		});
	}

	/** A branch's own run of text and holes, bound as a clause of its own. */
	parts(
		parts: readonly SkeletonPart[],
		rowType: string | undefined,
	): Expression {
		const bound = bindCsqlParts(parts, this.state, rowType);
		if ("kind" in bound) return bound;
		throw new Stop(bound);
	}

	comparison(
		kind: ComparisonKind,
		op: string,
		leftNode: FormSyntax,
		rightNode: FormSyntax,
		rowType: string | undefined,
	): Expression {
		const leftAt = bare(leftNode);
		if (markerAt(leftAt, this.markers) !== undefined)
			refuseWith(RUNTIME_NAMES, "csql:hole-as-property");
		if (leftAt.kind === "call" && leftAt.name === "subcase-count") {
			const count = this.subcaseCount(leftAt, rowType);
			const right = bare(rightNode);
			if (right.kind !== "number") {
				// A Search field's answer bounds the count as the number it
				// converts to, `double(input)`, the bound Nova's authoring writes.
				const bound = this.value(rightNode, count, false, rowType);
				return {
					kind,
					left: count,
					right:
						bound.kind === "term" && bound.term.kind === "input"
							? { kind: "double", value: bound }
							: bound,
				};
			}
			return {
				kind,
				left: count,
				right: term({ kind: "literal", value: right.value }),
			};
		}
		if (leftAt.kind === "call") refuseWith(HQ_REFUSES, "csql:function-on-left");
		const rightAt = bare(rightNode);
		if (
			rightAt.kind === "name" ||
			rightAt.kind === "child" ||
			rightAt.kind === "axis"
		) {
			if (markerAt(rightAt, this.markers) === undefined)
				refuseWith(HQ_REFUSES, "csql:property-on-right");
		}
		// `a/@case_id = v`: the ancestor's id, HQ's flag-free spelling.
		const ancestorId = this.ancestorCaseId(leftAt);
		if (ancestorId !== undefined && kind === "eq") {
			// The id is text whatever case it names, so the value reads the
			// same opposite the untyped id as opposite the typed one.
			const right = this.value(
				rightNode,
				term({ kind: "prop", property: "case_id" } as PropertyRef),
				false,
				rowType,
			);
			// The emitter writes this spelling only where every step that names
			// a case type names the type of `v`'s case
			// (`csql/emitter.ts::flagFreeAncestorCaseId`), and the checker
			// admits a step other than `parent` only where it names one, so
			// each such step names `v`'s type.
			const valueType = typeOf(right, this.state.context)?.caseIdOf;
			const steps = ancestorId.map((step) =>
				step.identifier === "parent" || valueType === undefined
					? step
					: { ...step, throughCaseType: valueType },
			);
			const destination =
				steps.at(-1)?.throughCaseType ??
				relationDestination(this.state.env.doc, rowType, {
					kind: "ancestor",
					steps: ancestorId.map((step) => step.identifier),
				});
			const left = term({
				kind: "prop",
				...(destination === undefined ? {} : { caseType: destination }),
				property: "case_id",
			} as PropertyRef);
			return {
				kind: "exists",
				via: {
					kind: "ancestor",
					via: steps as [RelationStep, ...RelationStep[]],
				},
				where: { kind: "eq", left, right },
			};
		}
		if (ORDERINGS.has(op)) {
			// HQ orders a property by a number, or by a date or a date and time
			// it parses from the text, and refuses any other value
			// (`comparison.py::case_property_range_query`).
			const text = stringOf(rightAt);
			if (
				text !== undefined &&
				this.splitMarkers(text).every((piece) => piece.kind === "text") &&
				!orderable(text)
			)
				refuseWith(
					UNTYPED_RIGHT_SIDE,
					"csql:untyped-right-side",
					`csql-op:${op}`,
				);
		}
		const anchor = this.anchor(leftAt, rowType);
		if (
			this.state.proposals &&
			kind === "eq" &&
			stringOf(rightNode) === "" &&
			anchor.kind === "term" &&
			anchor.term.kind === "prop"
		)
			return { kind: "is-blank", left: anchor };
		return {
			kind,
			left: anchor,
			right: this.value(rightNode, anchor, ORDERINGS.has(op), rowType),
		};
	}

	/** `(p >= v and p <= v)` on a date-and-time property: the equality Nova writes that way. */
	proposedEquality(
		node: Extract<FormSyntax, { kind: "binary" }>,
		rowType: string | undefined,
	): Expression | undefined {
		if (!this.state.proposals || node.op !== "and") return undefined;
		const left = bare(node.left);
		const right = bare(node.right);
		if (
			left.kind !== "binary" ||
			right.kind !== "binary" ||
			left.op !== ">=" ||
			right.op !== "<=" ||
			!sameNode(left.left, right.left)
		)
			return undefined;
		const anchor = this.anchor(bare(left.left), rowType);
		// A property of a related case's filter is typed on that case's row.
		if (
			scalarDataType(typeOf(anchor, this.oppositeContext(anchor))?.data) !==
			"datetime"
		)
			return undefined;
		// The value is printed twice, each a hole of its own where it holds a
		// device value, so the two are compared bound.
		const lower = this.value(left.right, anchor, false, rowType);
		const upper = this.value(right.right, anchor, false, rowType);
		if (!sameJson(lower, upper)) return undefined;
		return { kind: "eq", left: anchor, right: lower };
	}

	/** The steps of `a/b/@case_id`, where the anchor is an ancestor's id. */
	ancestorCaseId(node: FormSyntax): RelationStep[] | undefined {
		const path = this.path(node);
		if (path === undefined || path.length < 2) return undefined;
		const last = path.at(-1);
		if (last?.attribute !== true || last.name !== "case_id") return undefined;
		return path.slice(0, -1).map((step) => {
			if (step.attribute) refuseWith(HQ_REFUSES, "csql:attribute-in-path");
			return { identifier: step.name };
		});
	}

	/** A relative path of names and a last attribute, as its steps. */
	path(
		node: FormSyntax,
	): { readonly name: string; readonly attribute: boolean }[] | undefined {
		const at = bare(node);
		if (at.kind === "name" && !at.wildcard) {
			if (holdsMarker(at.name, this.state.prefix))
				refuseWith(RUNTIME_NAMES, "csql:hole-in-path");
			return [{ name: at.name, attribute: false }];
		}
		if (at.kind === "axis" && at.axis === "attribute") {
			const value = bare(at.value);
			return value.kind === "name"
				? [{ name: value.name, attribute: true }]
				: undefined;
		}
		if (at.kind === "child" && !at.descendant) {
			if (at.left === undefined) refuseWith(HQ_REFUSES, "csql:absolute-path");
			if (bare(at.left).kind === "root")
				refuseWith(HQ_REFUSES, "csql:absolute-path");
			const head = this.path(at.left);
			const tail = this.path(at.step);
			if (head === undefined || tail === undefined) return undefined;
			return [...head, ...tail];
		}
		if (at.kind === "root") refuseWith(HQ_REFUSES, "csql:absolute-path");
		return undefined;
	}

	anchor(node: FormSyntax, rowType: string | undefined): Expression {
		const path = this.path(node);
		if (path === undefined) {
			const at = bare(node);
			if (
				at.kind === "binary" &&
				at.op !== "and" &&
				at.op !== "or" &&
				!COMPARISONS.has(at.op)
			)
				refuseWith(HQ_REFUSES, "csql:arithmetic");
			unrecognizedRow();
		}
		const named = path[path.length - 1] as { name: string; attribute: boolean };
		const last = named.attribute
			? named
			: { ...named, name: csqlPropertyName(named.name) };
		if (path.length === 1) {
			if (last.attribute) {
				if (last.name === "case_type") return term({ kind: "case-row-type" });
				if (!RESERVED_CASE_ATTRIBUTES.has(last.name)) unrecognizedRow();
			}
			return term({
				kind: "prop",
				...(rowType === undefined ? {} : { caseType: rowType }),
				property: last.name,
			} as PropertyRef);
		}
		const steps = path.slice(0, -1);
		if (steps.some((step) => step.attribute))
			refuseWith(HQ_REFUSES, "csql:attribute-in-path");
		if (last.attribute && !RESERVED_CASE_ATTRIBUTES.has(last.name))
			unrecognizedRow();
		return term({
			kind: "prop",
			...(rowType === undefined ? {} : { caseType: rowType }),
			property: last.name,
			via: {
				kind: "ancestor",
				via: steps.map((step) => ({ identifier: step.name })) as [
					RelationStep,
					...RelationStep[],
				],
			},
		} as PropertyRef);
	}

	/** A value HQ reads or the device splices in. `opposite` types a literal. */
	value(
		node: FormSyntax,
		opposite: Expression | undefined,
		ordering: boolean,
		rowType: string | undefined,
	): Expression {
		const at = bare(node);
		const marker = markerAt(at, this.markers);
		// A choice where a value stands is the device's own `if(…)`, a value,
		// unless it is the choice that writes a bare bound's zero.
		if (marker !== undefined)
			return bindDevice(
				(marker.kind === "choice" ? bareZeroBound(marker.node) : undefined) ??
					marker.node,
				this.state,
			);
		switch (at.kind) {
			case "string":
				return this.stringValue(at.value, opposite, ordering);
			case "number":
				return term({ kind: "literal", value: at.value });
			case "negative": {
				const inner = bare(at.value);
				if (inner.kind !== "number") refuseWith(HQ_REFUSES, "csql:arithmetic");
				return term({ kind: "literal", value: -inner.value });
			}
			case "call":
				return this.valueCall(at, rowType);
			case "binary":
				refuseWith(HQ_REFUSES, `csql:operator:${at.op}`);
				break;
			case "variable":
				refuseWith(HQ_REFUSES, "csql:variable");
				break;
			default:
				refuseWith(HQ_REFUSES, "csql:property-on-right");
		}
	}

	/** A string HQ reads: one hole, text and holes, or a literal typed by its shape. */
	stringValue(
		value: string,
		opposite: Expression | undefined,
		ordering: boolean,
	): Expression {
		const pieces = this.splitMarkers(value);
		// A text compared with the case's own type names a case type, as the
		// form parser binds it (`expressionAst.ts::choiceFor`).
		if (
			pieces.length === 1 &&
			pieces[0]?.kind === "text" &&
			opposite?.kind === "term" &&
			opposite.term.kind === "case-row-type"
		)
			return term({ kind: "case-type", caseType: value });
		if (pieces.length === 1 && pieces[0]?.kind === "text")
			return term(
				shapedLiteral(
					value,
					opposite,
					this.oppositeContext(opposite),
					ordering,
				) as Literal,
			);
		if (pieces.length === 1 && pieces[0]?.kind === "hole")
			return bindDevice(pieces[0].node, this.state);
		const parts = pieces.map((piece) =>
			piece.kind === "text"
				? term({ kind: "literal", value: piece.text })
				: bindDevice(piece.node, this.state),
		);
		return { kind: "concat", parts: parts as [Expression, ...Expression[]] };
	}

	/** The context `opposite` is typed in: a property of a related case's
	 *  filter is read on that case's row. */
	oppositeContext(opposite: Expression | undefined): ExpressionContext {
		return opposite?.kind === "term" &&
			opposite.term.kind === "prop" &&
			opposite.term.caseType !== undefined &&
			opposite.term.via === undefined
			? pushRowScope(this.state.context, {
					kind: "case",
					root: "casedb",
					caseType: opposite.term.caseType,
				})
			: this.state.context;
	}

	/** A string's text cut at each marker it holds. */
	splitMarkers(
		value: string,
	): ({ kind: "text"; text: string } | { kind: "hole"; node: FormSyntax })[] {
		const out: (
			| { kind: "text"; text: string }
			| { kind: "hole"; node: FormSyntax }
		)[] = [];
		let rest = value;
		while (rest.length > 0) {
			let first: { index: number; marker: string } | undefined;
			for (const marker of this.markers.keys()) {
				const index = rest.indexOf(marker);
				if (index !== -1 && (first === undefined || index < first.index))
					first = { index, marker };
			}
			if (first === undefined) {
				out.push({ kind: "text", text: rest });
				break;
			}
			if (first.index > 0)
				out.push({ kind: "text", text: rest.slice(0, first.index) });
			// A choice inside a string is the device's own `if(…)`, a value.
			const part = this.markers.get(
				first.marker,
			) as Assembled["markers"][number]["part"];
			out.push({ kind: "hole", node: part.node });
			rest = rest.slice(first.index + first.marker.length);
		}
		return out;
	}

	valueCall(
		at: Extract<FormSyntax, { kind: "call" }>,
		rowType: string | undefined,
	): Expression {
		if (holdsMarker(at.name, this.state.prefix))
			refuseWith(RUNTIME_NAMES, "csql:hole-as-function");
		if (!CSQL_VALUE_FUNCTIONS.has(at.name))
			refuseWith(HQ_REFUSES, `csql:function:${at.name}`);
		const args = at.args;
		switch (at.name) {
			case "today":
				if (args.length !== 0) unrecognizedRow();
				return { kind: "today", clock: "project-space" };
			case "now":
				if (args.length !== 0) unrecognizedRow();
				return { kind: "now" };
			case "date":
			case "datetime":
			case "double": {
				if (args.length !== 1) unrecognizedRow();
				const bareArg = bare(args[0] as FormSyntax);
				const shape =
					at.name !== "double" &&
					bareArg.kind === "string" &&
					this.splitMarkers(bareArg.value).every((one) => one.kind === "text")
						? literalShape(bareArg.value)
						: undefined;
				// A date or a date and time literal Nova stores typed by its
				// shape prints the same text as the untyped one.
				const inner =
					shape !== undefined &&
					bareArg.kind === "string" &&
					(shape.type === "date" || shape.type === "datetime")
						? term({
								kind: "literal",
								value: bareArg.value,
								data_type: shape.type,
							})
						: this.value(args[0] as FormSyntax, undefined, false, rowType);
				return {
					kind:
						at.name === "date"
							? "date-coerce"
							: at.name === "datetime"
								? "datetime-coerce"
								: "double",
					value: inner,
				};
			}
			case "date-add":
			case "datetime-add": {
				if (args.length !== 3) unrecognizedRow();
				const interval = stringOf(args[1]);
				if (
					interval === undefined ||
					!(DATE_ADD_INTERVALS as readonly string[]).includes(interval)
				)
					unrecognizedRow();
				// A date or a date and time literal Nova stores typed prints
				// the same text as the untyped one, and only the typed one is
				// a date to add to.
				const base = bare(args[0] as FormSyntax);
				const baseShape =
					base.kind === "string" &&
					this.splitMarkers(base.value).every((one) => one.kind === "text")
						? literalShape(base.value)
						: undefined;
				return {
					kind: "date-add",
					date:
						base.kind === "string" &&
						(baseShape?.type === "date" || baseShape?.type === "datetime")
							? term({
									kind: "literal",
									value: base.value,
									data_type: baseShape.type,
								})
							: this.value(args[0] as FormSyntax, undefined, false, rowType),
					interval: interval as DateAddInterval,
					quantity: this.value(
						args[2] as FormSyntax,
						undefined,
						false,
						rowType,
					),
				};
			}
			case "unwrap-list":
				return this.valueList(args);
			default:
				unrecognizedRow();
		}
	}

	/** `unwrap-list('<json>')`: the array's strings as literals, a hole inside
	 *  the array as a value the device works out. */
	valueList(args: readonly FormSyntax[]): Expression {
		const json = args.length === 1 ? stringOf(args[0]) : undefined;
		if (json === undefined) unrecognizedRow();
		let items: unknown;
		try {
			items = parseHqJsonText(json);
		} catch (error) {
			rethrowWorkStop(error);
			unrecognizedRow();
		}
		if (!Array.isArray(items) || items.length === 0) unrecognizedRow();
		const values = items.map((item) => {
			if (typeof item !== "string") unrecognizedRow();
			const pieces = this.splitMarkers(item);
			if (pieces.length === 1 && pieces[0]?.kind === "hole")
				return bindDevice(pieces[0].node, this.state);
			if (pieces.some((piece) => piece.kind === "hole")) unrecognizedRow();
			return term({ kind: "literal", value: item });
		});
		return {
			kind: "value-list",
			items: values as [Expression, ...Expression[]],
		};
	}

	queryCall(
		at: Extract<FormSyntax, { kind: "call" }>,
		rowType: string | undefined,
	): Expression {
		if (holdsMarker(at.name, this.state.prefix))
			refuseWith(RUNTIME_NAMES, "csql:hole-as-function");
		if (!CSQL_QUERY_FUNCTIONS.has(at.name)) {
			if (CSQL_VALUE_FUNCTIONS.has(at.name))
				refuseWith(HQ_REFUSES, `csql:value-function-as-query:${at.name}`);
			refuseWith(HQ_REFUSES, `csql:function:${at.name}`);
		}
		const args = at.args;
		switch (at.name) {
			case "match-all":
			case "match-none":
				if (args.length !== 0) unrecognizedRow();
				return { kind: at.name };
			case "not": {
				if (args.length !== 1) unrecognizedRow();
				// A date-and-time property's inequality prints as the not of the
				// range from the value to itself, unparenthesized
				// (`csql/emitter.ts::compare`), where the not of its equality
				// keeps the equality's parentheses.
				const argument = args[0] as FormSyntax;
				if (argument.kind === "binary") {
					const equality = this.proposedEquality(argument, rowType);
					if (equality?.kind === "eq")
						return {
							kind: "neq",
							left: equality.left,
							right: equality.right,
						};
				}
				const inner = this.query(argument, rowType);
				if (this.state.proposals && inner.kind === "exists")
					return {
						kind: "missing",
						via: inner.via,
						...(inner.where === undefined ? {} : { where: inner.where }),
					};
				return { kind: "not", clause: inner };
			}
			case "selected":
			case "selected-any":
			case "selected-all":
				return this.selection(at.name, args, rowType);
			case "starts-with":
			case "fuzzy-match":
			case "phonetic-match":
			case "fuzzy-date": {
				if (args.length !== 2) unrecognizedRow();
				const property = this.propertyArgument(args[0] as FormSyntax, rowType);
				return {
					kind: "match",
					property,
					value: this.value(
						args[1] as FormSyntax,
						term(property),
						false,
						rowType,
					),
					mode: MATCH_MODES.get(at.name) as Extract<
						Expression,
						{ kind: "match" }
					>["mode"],
				};
			}
			case "within-distance": {
				if (args.length !== 4) unrecognizedRow();
				const property = this.propertyArgument(args[0] as FormSyntax, rowType);
				const center =
					this.geopointCenter(args[1] as FormSyntax) ??
					this.value(args[1] as FormSyntax, undefined, false, rowType);
				const distanceNode = bare(args[2] as FormSyntax);
				const unitText = stringOf(args[3]);
				return {
					kind: "within-distance",
					property,
					center,
					distance:
						distanceNode.kind === "number"
							? distanceNode.value
							: this.value(distanceNode, undefined, false, rowType),
					unit:
						unitText !== undefined &&
						this.splitMarkers(unitText).every((piece) => piece.kind === "text")
							? (unitText as Extract<
									Expression,
									{ kind: "within-distance" }
								>["unit"])
							: this.value(args[3] as FormSyntax, undefined, false, rowType),
				};
			}
			case "subcase-exists":
				return this.subcaseExists(args, rowType);
			case "ancestor-exists":
				return this.ancestorExists(args, rowType);
			case "subcase-count":
				// Only the left side of a comparison counts.
				refuseWith(HQ_REFUSES, "csql:subcase-count-alone");
				break;
			default:
				unrecognizedRow();
		}
	}

	/** A center the device works out, as Nova writes it: the value between
	 *  quote marks, read through the emitter's geopoint normalization
	 *  (`wire/geopoint.ts::normalizeGeopoint`, `replace(replace(translate(V,
	 *  …), …), …)`), proposed as V. The row's print proves it. */
	geopointCenter(node: FormSyntax): Expression | undefined {
		const text = stringOf(node);
		if (text === undefined) return undefined;
		const pieces = this.splitMarkers(text);
		const [only] = pieces;
		if (pieces.length !== 1 || only?.kind !== "hole") return undefined;
		const spaces = callOf(only.node, "replace", 3);
		const ends =
			spaces === undefined
				? undefined
				: callOf(spaces.args[0] as FormSyntax, "replace", 3);
		const commas =
			ends === undefined
				? undefined
				: callOf(ends.args[0] as FormSyntax, "translate", 3);
		const value = commas?.args[0];
		return value === undefined ? undefined : bindDevice(value, this.state);
	}

	propertyArgument(node: FormSyntax, rowType: string | undefined): PropertyRef {
		const anchor = this.anchor(node, rowType);
		if (anchor.kind !== "term" || anchor.term.kind !== "prop")
			unrecognizedRow();
		return anchor.term;
	}

	selection(
		name: "selected" | "selected-any" | "selected-all",
		args: readonly FormSyntax[],
		rowType: string | undefined,
	): Expression {
		if (args.length !== 2) unrecognizedRow();
		const property = this.propertyArgument(args[0] as FormSyntax, rowType);
		const valueNode = args[1] as FormSyntax;
		const literal = stringOf(valueNode);
		const quantifier = name === "selected-all" ? "all" : "any";
		if (
			literal !== undefined &&
			this.splitMarkers(literal).every((piece) => piece.kind === "text")
		) {
			const tokens = literal.split(/\s+/u).filter((token) => token.length > 0);
			const values =
				this.state.proposals && tokens.length > 1 ? tokens : [literal];
			return {
				kind: "multi-select-contains",
				property,
				values: values.map((value) => ({ kind: "literal", value })) as [
					Literal,
					...Literal[],
				],
				// One fixed value prints `selected(p, 'v')` whatever the quantifier, which reads
				// back as any (`canonical.ts`, `selection-per-value`).
				quantifier: values.length === 1 ? "any" : quantifier,
			};
		}
		return {
			kind: "multi-select-contains",
			property,
			values: [this.value(valueNode, undefined, false, rowType)],
			quantifier,
		};
	}

	/** `(@case_type = 'T' and (q))`, the type test the emitter writes into a
	 *  relation's filter, or `(q)`: T and q, each without the one pair of
	 *  parentheses the emitter writes around it, so a pair q itself holds (a
	 *  selection's, a membership's) stays q's. */
	typedFilter(node: FormSyntax | undefined): {
		readonly caseType?: string;
		readonly filter?: FormSyntax;
	} {
		if (node === undefined) return {};
		const inner = unparenthesized(node);
		const at = bare(inner);
		if (at.kind === "binary" && at.op === "and") {
			const test = bare(at.left);
			if (
				test.kind === "binary" &&
				test.op === "=" &&
				this.path(test.left)?.length === 1 &&
				this.path(test.left)?.[0]?.attribute === true &&
				this.path(test.left)?.[0]?.name === "case_type" &&
				stringOf(test.right) !== undefined
			)
				return {
					caseType: stringOf(test.right) as string,
					filter: unparenthesized(at.right),
				};
		}
		return { filter: inner };
	}

	/** A relation's filter, bound under the related case's type; `match-all()` is no filter. */
	relationWhere(
		filter: FormSyntax | undefined,
		destination: string | undefined,
	): Expression | undefined {
		if (filter === undefined) return undefined;
		const where = this.query(filter, destination);
		return where.kind === "match-all" ? undefined : where;
	}

	subcaseExists(
		args: readonly FormSyntax[],
		rowType: string | undefined,
	): Expression {
		if (args.length !== 1 && args.length !== 2) unrecognizedRow();
		const identifier = stringOf(args[0]);
		if (identifier === undefined) unrecognizedRow();
		const { caseType, filter } = this.typedFilter(args[1]);
		const destination =
			caseType ??
			relationDestination(this.state.env.doc, rowType, {
				kind: "subcase",
				identifier,
			});
		const where = this.relationWhere(filter, destination);
		return {
			kind: "exists",
			via: {
				kind: "subcase",
				identifier,
				...(caseType === undefined ? {} : { ofCaseType: caseType }),
			},
			...(where === undefined ? {} : { where }),
		};
	}

	ancestorExists(
		args: readonly FormSyntax[],
		rowType: string | undefined,
	): Expression {
		if (args.length !== 2) unrecognizedRow();
		const path = this.path(args[0] as FormSyntax);
		if (path === undefined || path.some((step) => step.attribute))
			unrecognizedRow();
		const { caseType, filter } = this.typedFilter(args[1]);
		const steps: RelationStep[] = path.map((step, index) => ({
			identifier: step.name,
			...(caseType !== undefined && index === path.length - 1
				? { throughCaseType: caseType }
				: {}),
		}));
		const destination =
			caseType ??
			relationDestination(this.state.env.doc, rowType, {
				kind: "ancestor",
				steps: path.map((step) => step.name),
			});
		const where = this.relationWhere(filter, destination);
		return {
			kind: "exists",
			via: {
				kind: "ancestor",
				via: steps as [RelationStep, ...RelationStep[]],
			},
			...(where === undefined ? {} : { where }),
		};
	}

	subcaseCount(
		at: Extract<FormSyntax, { kind: "call" }>,
		rowType: string | undefined,
	): Expression {
		if (at.args.length !== 1 && at.args.length !== 2) unrecognizedRow();
		const identifier = stringOf(at.args[0]);
		if (identifier === undefined) unrecognizedRow();
		const { caseType, filter } = this.typedFilter(at.args[1]);
		const destination =
			caseType ??
			relationDestination(this.state.env.doc, rowType, {
				kind: "subcase",
				identifier,
			});
		const where = this.relationWhere(filter, destination);
		return {
			kind: "count",
			via: {
				kind: "subcase",
				identifier,
				...(caseType === undefined ? {} : { ofCaseType: caseType }),
			},
			...(where === undefined ? {} : { where }),
		};
	}
}

/** A run of parts bound under `rowType`: a presence at the root as
 *  `when-input-present`, anything else as the CSQL its text holds. */
function bindCsqlParts(
	parts: readonly SkeletonPart[],
	state: BindState,
	rowType: string | undefined,
): Expression | Refusal | { readonly unrecognized: true } {
	try {
		const [only] = parts;
		if (parts.length === 1 && only?.kind === "presence") {
			const input = bindDevice(only.input, state);
			if (input.kind !== "term" || input.term.kind !== "input")
				unrecognizedRow();
			const clause = bindCsqlParts(only.body, state, rowType);
			if (!("kind" in clause)) return clause;
			return {
				kind: "when-input-present",
				input: input.term as SearchInputRef,
				clause,
			};
		}
		const assembled = assemble(parts, state.prefix);
		let read: ReturnType<typeof readFormSyntax>;
		try {
			read = readFormSyntax(assembled.text);
		} catch (error) {
			rethrowWorkStop(error);
			read = { ok: false, issues: [] };
		}
		if (!read.ok || read.node === undefined) {
			if (assembled.markers.length > 0)
				refuseWith(RUNTIME_NAMES, "csql:unparsed-with-holes");
			unrecognizedRow();
		}
		if (unparenthesizedCall(read.node))
			refuseWith(UNPARENTHESIZED, "csql:unparenthesized-call");
		const markers = new Map(
			assembled.markers.map((entry) => [entry.marker, entry.part] as const),
		);
		return new CsqlBinder(state, markers).query(read.node, rowType);
	} catch (stop) {
		rethrowWorkStop(stop);
		if (stop instanceof Stop) return stop.outcome;
		throw stop;
	}
}

/** Assembles each run of text and holes, parses it with
 *  `readFormSyntax` and binds it under `context`; a `presence` or `choice`
 *  part binds its bodies by the same call. */
function bindCsql(
	parts: readonly SkeletonPart[],
	context: ExpressionContext,
	env: SearchRowEnv,
	options: { readonly text: string; readonly proposals: boolean },
): {
	readonly bound: Bound;
	readonly tableReads: ReadonlySet<FormSyntax>;
} {
	const state: BindState = {
		context,
		env,
		text: options.text,
		prefix: markerPrefix(constantTexts(parts)),
		proposals: options.proposals,
		tableReads: new Set(),
	};
	const bound = bindCsqlParts(parts, state, rowCaseType(context));
	return { bound, tableReads: state.tableReads };
}

// ── Acceptance ───────────────────────────────────────────────────────

const namings = new WeakMap<object, ReturnType<typeof lookupWireNaming>>();
/** The emission context the module's search rows are written in. */
function emissionContext(
	context: ExpressionContext,
	env: SearchRowEnv,
): CsqlEmissionContext {
	let naming = namings.get(env.lookup);
	if (naming === undefined) {
		naming = lookupWireNaming([
			...env.lookup.values(),
		] as unknown as readonly LookupTableDefinition[]);
		namings.set(env.lookup, naming);
	}
	const moduleUuid = context.slot.uuid as Uuid;
	const mod = env.doc.modules[moduleUuid];
	const config = mod === undefined ? undefined : effectiveCaseSearchConfig(mod);
	const wire =
		config === undefined
			? undefined
			: searchWireShape(config, mod?.searchResultsName);
	return {
		types: context,
		bindings: {
			...(wire === undefined
				? {}
				: { searchInputInstanceId: searchInputInstanceId(wire) }),
			datumId: caseListStepDatumId(env.doc, moduleUuid, "id"),
			lookup: { naming, instanceScope: "suite" },
		},
	};
}

function printed(wire: WireExpr): FormSyntax | undefined {
	const text = serializeWire(wire, {
		target: "hq-json",
		interpolation: "none",
	}).text;
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

/** Exact: Nova's wrapper, printed as the HQ JSON holds it, is the source's tree. */
function exact(
	source: FormSyntax,
	candidate: Expression,
	context: CsqlEmissionContext,
): boolean {
	const print = printed(emitCsql(candidate, context).wrapper);
	return print !== undefined && sameNode(source, print);
}

/** The source node at which the row's wrapper first differs from Nova's own
 *  wrapper of `candidate`, printed as the HQ JSON holds it. */
function wrapperDifference(
	source: FormSyntax,
	candidate: Expression,
	context: CsqlEmissionContext,
): FormSyntax | undefined {
	const print = printed(emitCsql(candidate, context).wrapper);
	return print === undefined
		? undefined
		: firstDifference(source, print, { ruleSet: "record" });
}

/** The candidate's CSQL as text with markers, and the device value each stands for. */
interface CandidateText {
	readonly text: string;
	readonly holes: readonly WireExpr[];
	/** The device's day is spliced in as a value, between quote marks. */
	readonly deviceDay: boolean;
	/** A hole or an obligation besides the device's day. */
	readonly guarded: boolean;
}

function isTodayCall(wire: WireExpr): boolean {
	return wire.k === "call" && wire.fn === "today" && wire.args.length === 0;
}

/** Preserve each runtime hole. The project space’s day is a server value in the constant CSQL. */
function candidateText(
	tree: CsqlNode,
	prefix: string,
): CandidateText | undefined {
	const segments = printCsql(tree);
	let text = "";
	const holes: WireExpr[] = [];
	let deviceDay = false;
	let guarded = false;
	const mark = (value: WireExpr): void => {
		text += `${prefix}nova_hole_${holes.length}__`;
		holes.push(value);
	};
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === undefined) continue;
		if (segment.kind === "constant") {
			text += segment.text;
			continue;
		}
		if (segment.rejectWhen !== undefined) guarded = true;
		if (segment.value === undefined) {
			// A carrier splices nothing; a choice is one device value.
			if (segment.key !== undefined) mark(segment.xpath);
			continue;
		}
		if (segment.stringValueXPath !== undefined) {
			guarded = true;
			const value = segment.stringValueXPath;
			if (value.k === "call" && value.fn === "concat") {
				text += '"';
				for (const arg of value.args) {
					if (arg.k === "str") text += arg.value;
					else mark(arg);
				}
				text += '"';
			} else {
				text += '"';
				mark(value);
				text += '"';
			}
			continue;
		}
		const next = segments[index + 1];
		if (
			isTodayCall(segment.value) &&
			text.endsWith('"') &&
			next?.kind === "constant" &&
			next.text.startsWith('"')
		) {
			deviceDay = true;
			mark(segment.xpath);
			continue;
		}
		guarded = true;
		// The device value as the row splices it in, a bare bound's zero
		// choice around it included.
		mark(segment.xpath);
	}
	return { text, holes, deviceDay, guarded };
}

/** The source's holes, in the order their markers stand in its text. */
function sourceText(
	parts: readonly SkeletonPart[],
	prefix: string,
):
	| { readonly text: string; readonly holes: readonly FormSyntax[] }
	| undefined {
	if (parts.some((part) => part.kind === "presence")) return undefined;
	const assembled = assemble(parts, prefix);
	return {
		text: assembled.text,
		holes: assembled.markers.map(({ part }) => part.node),
	};
}

/** The tests of an `or` of `and`s, each disjunct as its clauses. */
function disjuncts(node: FormSyntax): FormSyntax[][] {
	const split = (at: FormSyntax, op: string): FormSyntax[] => {
		const inner = bare(at);
		return inner.kind === "binary" && inner.op === op
			? [...split(inner.left, op), ...split(inner.right, op)]
			: [inner];
	};
	return split(node, "or").map((disjunct) => split(disjunct, "and"));
}

/** Whether every condition the source's wrapper sends `match-none()` under
 *  is one Nova's wrapper of the row rejects under too: each disjunct of each
 *  is, clause for clause in any order, a disjunct of one of the candidate's
 *  obligations. The guards level then changes only where Nova's wrapper
 *  fails closed and the source's did not, which is the rewrite it reports;
 *  a condition of the author's own, under which the source showed no case,
 *  is no guard of Nova's, and the row is not held at this level. */
function rejectsHeld(rejects: readonly FormSyntax[], tree: CsqlNode): boolean {
	if (rejects.length === 0) return true;
	const obligations: FormSyntax[][] = [];
	for (const rejection of csqlClauseWrapper(tree).runtimeRejections ?? []) {
		const condition = printed(rejection.condition);
		if (condition === undefined) return false;
		obligations.push(...disjuncts(condition));
	}
	const sameClauses = (a: FormSyntax[], b: FormSyntax[]): boolean => {
		if (a.length !== b.length) return false;
		const left = [...b];
		for (const clause of a) {
			const at = left.findIndex((other) => sameNode(clause, other));
			if (at < 0) return false;
			left.splice(at, 1);
		}
		return true;
	};
	return rejects.every((reject) =>
		disjuncts(reject).every((disjunct) =>
			obligations.some((obligation) => sameClauses(disjunct, obligation)),
		),
	);
}

/** What the guards level found between a source row and Nova's wrapper. */
interface GuardsLevel {
	/** The source splices the device's day in as Nova does, between its own quote marks. */
	readonly deviceDay: boolean;
	/** Nova's wrapper adds a guard or a quote choice around a device value. */
	readonly guarded: boolean;
	/** The source's CSQL names a selection by a spelling HQ's search reads as Nova's
	 *  (`hqSelectionSpelling`). */
	readonly respelled?: true;
}

/** A word HQ's search analyses into one token whatever the analyser's rules for other
 *  scripts: ASCII letters, digits and `_`, which the standard tokenizer joins, within its
 *  255-character token limit. */
const ONE_TOKEN = /^[A-Za-z0-9_]{1,255}$/u;

/**
 * `node` with each selection respelled as Nova prints the same query to HQ's search.
 * HQ's search names one function `selected` and `selected-any`
 * (`xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`), an analysed match on the value's
 * words that any one finds (`query_functions.py::_selected_query`, `es/queries.py::match`),
 * and `selected-all` the match all of them find. So `selected-any(p, 'a b')` finds what
 * `(selected(p, 'a') or selected(p, 'b'))` finds, the spelling Nova prints for a fixed value's
 * words (`csql/emitter.ts::selection`), and `selected-all(p, 'a b')` what
 * `(selected(p, 'a') and selected(p, 'b'))` finds where each word is one token. For a value
 * the device works out Nova prints `selected-any` and `selected-all` (`csql/emitter.ts::selection`),
 * so there `selected` is `selected-any`.
 *
 * HQ's index also keeps the case's name under the key `name` beside `case_name`, both the
 * one `name.exact` field (`case_search/const.py::INDEXED_METADATA_BY_KEY`), so a property
 * step `name` is the `case_name` Nova prints. An attribute `@name` is no property step.
 */
function hqSelectionSpelling(node: FormSyntax, prefix: string): FormSyntax {
	const within = (child: FormSyntax) => hqSelectionSpelling(child, prefix);
	switch (node.kind) {
		case "name":
			return !node.wildcard && node.name === "name"
				? { ...node, name: "case_name" }
				: node;
		case "group":
		case "negative":
			return { ...node, value: within(node.value) };
		case "axis":
			return node.axis === "attribute"
				? node
				: { ...node, value: within(node.value) };
		case "child":
			return {
				...node,
				...(node.left === undefined ? {} : { left: within(node.left) }),
				step: within(node.step),
			};
		case "filter":
			return { ...node, base: within(node.base), where: within(node.where) };
		case "binary":
			return { ...node, left: within(node.left), right: within(node.right) };
		case "call": {
			const args = node.args.map(within);
			const [property, value] = args;
			const literal =
				args.length === 2 && value !== undefined ? bare(value) : undefined;
			const runtime =
				literal !== undefined &&
				((literal.kind === "string" && holdsMarker(literal.value, prefix)) ||
					(literal.kind === "name" && holdsMarker(literal.name, prefix)));
			// A value the device works out: Nova spells HQ's one function `selected-any`.
			if (node.name === "selected" && runtime)
				return { ...node, name: "selected-any", args };
			if (
				(node.name !== "selected-any" && node.name !== "selected-all") ||
				property === undefined ||
				literal?.kind !== "string" ||
				runtime
			)
				return { ...node, args };
			const words = literal.value
				.split(/\s+/u)
				.filter((word) => word.length > 0);
			const all = node.name === "selected-all";
			if (
				words.length === 0 ||
				(all && !words.every((word) => ONE_TOKEN.test(word)))
			)
				return { ...node, args };
			if (words.length === 1) return { ...node, name: "selected", args };
			const at = { from: node.from, to: node.to };
			const tests = words.map(
				(word): FormSyntax => ({
					...at,
					kind: "call",
					name: "selected",
					args: [property, { ...at, kind: "string", value: word }],
				}),
			);
			const joined = tests.reduce(
				(left, right): FormSyntax => ({
					...at,
					kind: "binary",
					op: all ? "and" : "or",
					left,
					right,
				}),
			);
			return { ...at, kind: "group", value: joined };
		}
		default:
			return node;
	}
}

/** Guards: the same CSQL and, hole for hole, the same device values, and no
 *  condition the source fails closed under that Nova's wrapper does not. The
 *  device's day Nova splices in is read first as the source's server
 *  `today()`, then as the device's day the source splices in itself. */
function guards(
	row: RowSkeleton,
	tree: CsqlNode,
	prefix: string,
	unprinted: ReadonlySet<FormSyntax> = new Set(),
): GuardsLevel | undefined {
	const { parts, rejects } = row;
	const [only] = parts;
	if (parts.length === 1 && only?.kind === "presence") {
		if (tree.k !== "presence" || rejects.length > 0) return undefined;
		const trigger = printed(tree.trigger);
		if (trigger === undefined || !sameNode(only.input, trigger))
			return undefined;
		const inner = guards(
			{ parts: only.body, rejects: only.rejects },
			tree.clause,
			prefix,
			unprinted,
		);
		return inner === undefined ? undefined : { ...inner, guarded: true };
	}
	if (tree.k === "presence") return undefined;
	if (!rejectsHeld(rejects, tree)) return undefined;
	const source = sourceText(parts, prefix);
	if (source === undefined) return undefined;
	const left = readFormSyntax(source.text);
	if (!left.ok || left.node === undefined) return undefined;
	const respelling = hqSelectionSpelling(left.node, prefix);
	const candidate = candidateText(tree, prefix);
	if (!candidate || source.holes.length !== candidate.holes.length)
		return undefined;
	const right = readFormSyntax(candidate.text);
	if (!right.ok || right.node === undefined) return undefined;
	const same = sameNode(left.node, right.node);
	const respelled = !same && sameNode(respelling, right.node);
	if (!same && !respelled) return undefined;
	const sameHoles = source.holes.every((node, index) => {
		if (unprinted.has(node)) return true;
		const hole = printed(candidate.holes[index] as WireExpr);
		return hole !== undefined && sameNode(node, hole);
	});
	return sameHoles
		? {
				deviceDay: candidate.deviceDay,
				guarded: candidate.guarded,
				...(respelled && { respelled: true as const }),
			}
		: undefined;
}

/** The checker's and representability's refusal of a bound row, as its claim. */
function refusalOf(
	candidate: Expression,
	context: ExpressionContext,
	env: SearchRowEnv,
): Refusal | undefined {
	const errors = checkExpression(candidate, context).errors.filter(
		(error: CheckError) =>
			!(
				error.code === "arm-unavailable" &&
				error.reason === "platform-unavailable"
			),
	);
	const first = errors[0];
	if (first !== undefined) {
		const answer = checkErrorEntry(
			first,
			env.doc,
			{ ref: context.slot, searchRow: true },
			candidate,
		);
		return {
			entryId: answer.entryId === "slot-default" ? M7 : answer.entryId,
			detail: { name: "_xpath_query", reason: answer.reason },
		};
	}
	const issue = checkCsqlRepresentability(candidate, context)[0];
	if (issue !== undefined)
		return {
			entryId: M7,
			detail: { name: "_xpath_query", reason: `csql:${issue.reason}` },
		};
	return undefined;
}

/** The rewrites of the device values a row splices in, all withheld when
 *  the guards level compares them with the source's. */
const DEVICE_REWRITES: ReadonlySet<EmissionRewriteId> = new Set(
	EMISSION_REWRITE_IDS,
);

/** `emission` with every rewrite of a device value withheld, each one the
 *  print reaches added to `reached`. */
function withDeviceRewritesWithheld(
	emission: CsqlEmissionContext,
	reached: Set<EmissionRewriteId>,
): CsqlEmissionContext {
	return {
		...emission,
		rewrites: { withhold: DEVICE_REWRITES, reached: (id) => reached.add(id) },
	};
}

/** `rewrites`, then each rewrite in `reached` a worker meets, once. */
function changing(
	reached: ReadonlySet<EmissionRewriteId>,
	rewrites: readonly EmissionRewriteId[],
): EmissionRewriteId[] {
	return [
		...rewrites,
		...EMISSION_REWRITE_IDS.filter(
			(id) =>
				reached.has(id) &&
				EMISSION_REWRITES[id].behavior === "changes" &&
				!rewrites.includes(id),
		),
	];
}

/** The JSON key a search filter row sits in. */
const ROW_KEY = "schema:DefaultCaseSearchProperty.defaultValue";

/** A refusal as the row's claim, with the surface key its entry is answered
 *  under: the one the binder named, else by `claimKey` over the operators,
 *  functions and metadata names the row's CSQL uses, in document order. */
function rowClaim(
	refusal: Refusal,
	wrapper: FormSyntax,
): Extract<SearchRowReading, { readonly claim: unknown }>["claim"] {
	const keys: string[] = [];
	const csql = searchRowCsql(wrapper)?.csql;
	if (csql !== undefined)
		visitSyntax(csql, (node) => {
			if (node.kind === "binary") keys.push(`csql-op:${node.op}`);
			else if (node.kind === "call") keys.push(`csql-fn:${node.name}`);
			else if (node.kind === "name") keys.push(`csql-metadata:${node.name}`);
			else if (
				node.kind === "axis" &&
				node.axis === "attribute" &&
				node.value.kind === "name"
			)
				keys.push(`csql-metadata:@${node.value.name}`);
		});
	return {
		entryId: refusal.entryId,
		key: refusal.key ?? claimKey(refusal.entryId, ROW_KEY, keys),
		detail: refusal.detail,
	};
}

/** The property a CSQL property step names. HQ's index keeps the case's name
 *  under the key `name` as well as `case_name`, one `name.exact` field
 *  (`case_search/const.py::INDEXED_METADATA_BY_KEY`): both are Nova's `case_name`. */
export function csqlPropertyName(step: string): string {
	return step === "name" ? "case_name" : step;
}

/** One `_xpath_query` value read under the context of the slot the caller
 *  proposes: the case list filter's, or an advanced Search field's. */
export function readSearchFilterRow(
	text: string,
	context: ExpressionContext,
	env: SearchRowEnv,
): SearchRowReading {
	const unparsed = {
		ok: false,
		unrecognized: true,
		reason: "parse:syntax",
	} as const;
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch (error) {
		rethrowWorkStop(error);
		return unparsed;
	}
	if (!read.ok || read.node === undefined) return unparsed;
	const source = read.node;
	let firstRefusal: Refusal | undefined;
	// Where the source's wrapper first differs from Nova's own wrapper of a
	// reading, for the defect line of a row left unrecognized.
	let differing: FormSyntax = source;
	let differs = false;
	// Whether a binding printed back as the source but at device values that
	// read a lookup table's row, which Nova's print of them does not write.
	let tableReadDiffers = false;
	const unrecognized = () =>
		({
			ok: false,
			unrecognized: true,
			reason: `differs:${differing.kind}`,
		}) as const;
	// The skeleton that fails closed first, then, where the source fails
	// closed under a condition that is no guard of Nova's, the one that
	// reads that condition as the author's own choice.
	const skeletons = rowSkeletons(source);
	for (const [variant, row] of skeletons.entries()) {
		const last = variant === skeletons.length - 1;
		const { parts } = row;
		const prefix = markerPrefix(constantTexts(parts));
		const typing = comparedRowTypes(parts, context, env, text);
		const rowContext = withPropertyTypes(context, typing);
		const emission = emissionContext(rowContext, env);
		for (const proposals of [true, false]) {
			const { bound: raw, tableReads } = bindCsql(parts, rowContext, env, {
				text,
				proposals,
			});
			if ("unrecognized" in raw) {
				if (last) return unrecognized();
				break;
			}
			if (!("kind" in raw)) {
				if (last) return { ok: false, claim: rowClaim(raw, source) };
				break;
			}
			// A relation typed as the catalog resolves it, the canonical member of
			// the paths that print one row, and a literal spelled as a date or a
			// date and time typed where its position requires the type.
			const bound = typedWhereRequired(
				typedRelations(raw, rowContext),
				rowContext,
			);
			const refusal = refusalOf(bound, rowContext, env);
			if (refusal !== undefined) {
				firstRefusal ??= refusal;
				continue;
			}
			const types = typing.length === 0 ? {} : { types: typing };
			const reached = new Set<EmissionRewriteId>();
			// The device values Nova splices in, with every rewrite of theirs
			// withheld (a read of an answer guarded for no rows), so they
			// compare with the source's, and each reported.
			const withheld = withDeviceRewritesWithheld(emission, reached);
			let tree: CsqlNode;
			try {
				if (exact(source, bound, emission))
					return {
						ok: true,
						predicate: bound,
						level: "exact",
						rewrites: [],
						...types,
					};
				if (exact(source, bound, withheld))
					return {
						ok: true,
						predicate: bound,
						level: "guards",
						rewrites: changing(reached, []),
						...types,
					};
				tree = emitCsqlTree(bound, withheld);
			} catch (error) {
				rethrowWorkStop(error);
				continue;
			}
			const level = guards(row, tree, prefix);
			if (level === undefined) {
				if (
					tableReads.size > 0 &&
					guards(row, tree, prefix, tableReads) !== undefined
				)
					tableReadDiffers = true;
				if (!differs) {
					differing = wrapperDifference(source, bound, emission) ?? source;
					differs = true;
				}
				continue;
			}
			const rewrites: EmissionRewriteId[] = [];
			// The device's day between other quote marks than Nova's is the same CSQL
			// on every device, and a selection HQ's search reads as Nova's spelling of it
			// the same query, so neither alone is a rewrite a worker meets.
			if (level.guarded || !(level.deviceDay || level.respelled))
				rewrites.push("search-value-guards");
			return {
				ok: true,
				predicate: bound,
				level: "guards",
				rewrites: changing(reached, rewrites),
				...types,
				...(level.respelled && { respelled: true as const }),
			};
		}
	}
	// A binding that passed the checker and printed back unequal leaves the
	// row Nova's to explain, whatever another binding was refused for.
	if (firstRefusal !== undefined && !differs)
		return { ok: false, claim: rowClaim(firstRefusal, source) };
	// A table's row the device reads in a spelling Nova's print does not write
	// (HQ's page writes a row's column as `rows[1]/column`, which Nova prints
	// under its guard for no rows) is the device query, not a row Nova cannot
	// explain.
	if (tableReadDiffers)
		return {
			ok: false,
			claim: rowClaim(
				{
					entryId: DEVICE_QUERY,
					detail: { name: "_xpath_query", reason: "table-lookup" },
				},
				source,
			),
		};
	return unrecognized();
}

/** The types a row's comparisons give the properties its catalog holds
 *  untyped (`comparedTypes`), over the trees it binds to with and without
 *  the proposals: one type a property, or `decimal` where whole numbers and
 *  decimals meet. */
function comparedRowTypes(
	parts: readonly SkeletonPart[],
	context: ExpressionContext,
	env: SearchRowEnv,
	text: string,
): ComparedType[] {
	const untyped = (caseType: string, property: string): boolean => {
		const declared = context.facts.caseTypes
			.find((type) => type.name === caseType)
			?.properties.find((one) => one.name === property);
		return declared !== undefined && declared.data_type === undefined;
	};
	const found: ComparedType[] = [];
	for (const proposals of [true, false]) {
		const { bound } = bindCsql(parts, context, env, { text, proposals });
		if ("kind" in bound) found.push(...comparedTypes(bound, context, untyped));
	}
	return agreedComparedTypes(found);
}

/** The level at which Nova's emission of `predicate` in `context` writes the
 *  source row back: its wrapper exactly, or the same CSQL and device values
 *  with only Nova's guards around them. Undefined where it writes neither. */
export function searchRowLevel(
	source: FormSyntax,
	predicate: Expression,
	context: ExpressionContext,
	env: SearchRowEnv,
): "exact" | "guards" | undefined {
	const emission = emissionContext(context, env);
	try {
		if (exact(source, predicate, emission)) return "exact";
		const withheld = withDeviceRewritesWithheld(emission, new Set());
		if (exact(source, predicate, withheld)) return "guards";
		const tree = emitCsqlTree(predicate, withheld);
		return rowSkeletons(source).some(
			(row) =>
				guards(row, tree, markerPrefix(constantTexts(row.parts))) !== undefined,
		)
			? "guards"
			: undefined;
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

/** One run of a row's CSQL: its parsed text, each marker's device node, and
 *  the runs of each choice the device makes at a marker (`choices`, by the
 *  marker): the device sends one of a choice's runs in the marker's place,
 *  so what a run reads it reads where the marker stands, inside a relation's
 *  filter among them. */
export interface CsqlRun {
	readonly csql: FormSyntax;
	readonly holes: ReadonlyMap<string, FormSyntax>;
	readonly choices: ReadonlyMap<string, readonly CsqlRun[]>;
}

/** A row's CSQL as HQ's search reads it, with the holes in it: the parsed
 *  text the binding, the scans and the surface uses read, each marker's
 *  device node, the runs of each choice the device makes in it, at any
 *  depth, and the CSQL of each text the row can send HQ. Undefined where the
 *  text is no CSQL the grammar reads. */
export function searchRowCsql(wrapper: FormSyntax):
	| (CsqlRun & {
			readonly presence: boolean;
			/** The CSQL of each text the row can send HQ (`sentTexts`), its two
			 *  holes in `holes` too: the texts whose CSQL HQ's search parses,
			 *  each a use of what it names. */
			readonly sent: readonly FormSyntax[];
	  })
	| undefined {
	let { parts } = rowSkeleton(wrapper);
	let presence = false;
	// A presence test inside another's body tests a second field: the CSQL is
	// the innermost body.
	for (;;) {
		const [only] = parts;
		if (parts.length !== 1 || only?.kind !== "presence") break;
		presence = true;
		parts = only.body;
	}
	const run = csqlRunTree(parts);
	if (run === undefined) return undefined;
	const holes = new Map(run.holes);
	const literals: string[] = [];
	visitSyntax(wrapper, (node) => {
		if (node.kind === "string") literals.push(node.value);
	});
	const sentPrefix = markerPrefix([...literals, ...holes.keys()]);
	const marks = {
		hole: `${sentPrefix}nova_hole_sent__`,
		dateHole: `${sentPrefix}nova_hole_sent_date__`,
	};
	const sent: FormSyntax[] = [];
	for (const text of sentTexts(wrapper, marks, holes)) {
		const read = readFormSyntax(text);
		if (read.ok && read.node !== undefined) sent.push(read.node);
	}
	return { ...run, holes, presence, sent };
}

/** `parts` as one run, with the runs of each choice among its holes. */
function csqlRunTree(parts: readonly SkeletonPart[]): CsqlRun | undefined {
	const run = csqlRun(parts);
	if (run === undefined) return undefined;
	const choices = new Map<string, CsqlRun[]>();
	for (const [marker, choice] of run.choices) {
		const runs: CsqlRun[] = [];
		for (const branch of [choice.then, choice.otherwise]) {
			const inner = csqlRunTree(branch);
			if (inner !== undefined) runs.push(inner);
		}
		choices.set(marker, runs);
	}
	return { csql: run.csql, holes: run.holes, choices };
}

/** `parts` as one CSQL text, parsed, with its holes and the choices among
 *  them. */
function csqlRun(parts: readonly SkeletonPart[]):
	| {
			readonly csql: FormSyntax;
			readonly holes: ReadonlyMap<string, FormSyntax>;
			readonly choices: ReadonlyMap<
				string,
				Extract<SkeletonPart, { kind: "choice" }>
			>;
	  }
	| undefined {
	const prefix = markerPrefix(constantTexts(parts));
	const assembled = assemble(parts, prefix);
	const csql = readFormSyntax(assembled.text);
	if (!csql.ok || csql.node === undefined) return undefined;
	const holes = new Map<string, FormSyntax>();
	const choices = new Map<string, Extract<SkeletonPart, { kind: "choice" }>>();
	for (const { marker, part } of assembled.markers) {
		holes.set(marker, part.node);
		if (part.kind === "choice") choices.set(marker, part);
	}
	return { csql: csql.node, holes, choices };
}

/** Core's limit on the texts one `concat()` gives (`Shapes.MAX_STRINGS`). */
const SENT_TEXTS_LIMIT = 256;

/**
 * The texts a row's wrapper can send HQ's search, as Core's `xpathStrings`
 * reads them (`proof/core/.../Shapes.java::strings`, the reading the proof
 * lane's manifest check takes): a string literal is its text, a number its
 * text as `FunctionUtils.toString` writes it, `concat()` each combination of
 * its arguments' texts in order, cut at 256 distinct texts, `if()` the texts
 * of its two branches, `today()` the date hole and any other expression the
 * hole, a value only the device knows. Each hole is one marker (`marks`), as
 * Core's reading writes one text for every hole, each noted in `holes` beside
 * the first node it stands for.
 */
function sentTexts(
	node: FormSyntax,
	marks: { readonly hole: string; readonly dateHole: string },
	holes: Map<string, FormSyntax>,
): ReadonlySet<string> {
	const at = bare(node);
	if (at.kind === "string") return new Set([at.value]);
	if (at.kind === "number") return new Set([coreNumberText(at.value)]);
	if (at.kind === "call" && at.name === "concat") {
		let combined: ReadonlySet<string> = new Set([""]);
		for (const argument of at.args) {
			const parts = sentTexts(argument, marks, holes);
			const next = new Set<string>();
			for (const prefix of combined)
				for (const part of parts) {
					if (next.size >= SENT_TEXTS_LIMIT) break;
					next.add(prefix + part);
				}
			combined = next;
		}
		return combined;
	}
	if (at.kind === "call" && at.name === "if" && at.args.length === 3)
		return new Set([
			...sentTexts(at.args[1] as FormSyntax, marks, holes),
			...sentTexts(at.args[2] as FormSyntax, marks, holes),
		]);
	const mark =
		at.kind === "call" && at.name === "today" ? marks.dateHole : marks.hole;
	if (!holes.has(mark)) holes.set(mark, at);
	return new Set([mark]);
}

/** The text Core's `FunctionUtils.toString` gives a number. */
function coreNumberText(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (Math.abs(value) < 1e-12) return "0";
	if (!Number.isFinite(value)) return value < 0 ? "-Infinity" : "Infinity";
	// Java's `(int) d`: toward zero, held to an int's range.
	const whole = Math.max(-2147483648, Math.min(2147483647, Math.trunc(value)));
	if (Math.abs(value - whole) < 1e-12) return String(whole);
	// Java's `String.valueOf(double)`: plain from 10^-3 up to 10^7, else a
	// mantissa with at least one fraction digit and `E` before the exponent.
	const magnitude = Math.abs(value);
	if (magnitude >= 1e-3 && magnitude < 1e7) return String(value);
	const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
	return `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

/** The classes of what a held search row works out on the device, each the value class of an
 *  entry of the row's own key: a clause it chooses by a condition, and the runtime values it
 *  reads, the three session-context values that may be absent apart from the rest. */
export type SearchRowRuntimeClass =
	| "conditional-choice"
	| "case-or-datum-terms"
	| "session-context-drift-term"
	| "session-context-window-width-term"
	| "session-context-applanguage-term";

/**
 * The runtime classes a held row's predicate holds, in the order above, each once. A clause
 * chosen by `if` or `switch` where a clause stands is a conditional choice. A runtime value
 * reads the session (its datums and its context), the worker, a Search field's answer or a
 * property of the case chosen in a menu; `drift`, `window_width` and `applanguage` are each a
 * class of their own. A presence test reads no value, and a property of the searched case is
 * the query's own anchor, no runtime value.
 */
export function searchRowRuntimeClasses(
	predicate: Expression,
): readonly SearchRowRuntimeClass[] {
	const found = new Set<SearchRowRuntimeClass>();
	const clause = (node: Expression): void => {
		switch (node.kind) {
			case "and":
			case "or":
				for (const one of node.clauses) clause(one);
				return;
			case "not":
				clause(node.clause);
				return;
			case "when-input-present":
				clause(node.clause);
				return;
			case "if":
				found.add("conditional-choice");
				clause(node.then);
				clause(node.else);
				return;
			case "switch":
				found.add("conditional-choice");
				for (const one of node.cases) clause(one.then);
				clause(node.fallback);
				return;
			default:
				return;
		}
	};
	clause(predicate);
	const presence = new Set<object>();
	walkExpression(predicate, {
		visitExpression(expression) {
			if (expression.kind === "when-input-present")
				presence.add(expression.input);
			if (
				expression.kind === "project" &&
				readChosenCaseProperty(expression) !== undefined
			)
				found.add("case-or-datum-terms");
		},
		visitTerm(term) {
			if (presence.has(term)) return;
			switch (term.kind) {
				case "input":
				case "session-user":
				case "session-user-property":
				case "session-datum":
					found.add("case-or-datum-terms");
					return;
				case "session-context":
					found.add(
						term.field === "drift"
							? "session-context-drift-term"
							: term.field === "window_width"
								? "session-context-window-width-term"
								: term.field === "applanguage"
									? "session-context-applanguage-term"
									: "case-or-datum-terms",
					);
					return;
				default:
					return;
			}
		},
	});
	const order: readonly SearchRowRuntimeClass[] = [
		"conditional-choice",
		"case-or-datum-terms",
		"session-context-drift-term",
		"session-context-window-width-term",
		"session-context-applanguage-term",
	];
	return order.filter((one) => found.has(one));
}

/**
 * Whether a held row compares a case property as HQ's search alone does, by its own conversion of
 * the value (`searchIndexedComparison.ts::searchIndexedComparison`), where Nova's own rules would
 * type the comparison otherwise: a text or time property ordered against a number, a date or a
 * date and time, or against a worker's text the search converts when it runs, and a date-and-time
 * property tested for equality with text. HQ orders by the number the value converts to, else by
 * its date or date and time (`xpath_functions/comparison.py::case_property_range_query`), and
 * tests equality on the stored spelling (`es/case_search.py::case_property_query`), so each runs.
 * A comparison the device works out inside a value is the device's, by its own rules.
 */
export function holdsHqConvertedComparison(
	predicate: Expression,
	context: ExpressionContext,
	types: readonly ComparedType[],
): boolean {
	const typed = withPropertyTypes(context, types);
	const positions = csqlPositions(predicate);
	const typeAt = (expression: Expression): string | undefined => {
		try {
			return scalarDataType(typeOf(expression, typed)?.data);
		} catch (error) {
			rethrowWorkStop(error);
			return undefined;
		}
	};
	let found = false;
	walkExpression(predicate, {
		visitExpression(node, path) {
			if (found || !(COMPARISON_KINDS as readonly string[]).includes(node.kind))
				return;
			if (csqlPositionAt(positions, path) === "runtime") return;
			const comparison = node as Extract<Expression, { kind: ComparisonKind }>;
			const leftType = typeAt(comparison.left);
			const rightType = typeAt(comparison.right);
			if (leftType === undefined || rightType === undefined) return;
			found =
				searchIndexedComparison(
					comparison.kind === "eq" || comparison.kind === "neq",
					comparison.left,
					leftType,
					comparison.right,
					rightType,
				) !== undefined;
		},
	});
	return found;
}
