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
} from "@/lib/domain/expression/context";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import {
	type CheckError,
	checkExpression,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import type {
	ComparisonKind,
	DateAddInterval,
	Expression,
	Literal,
	PropertyRef,
	RelationStep,
	SearchInputRef,
	Term,
} from "@/lib/domain/expression/types";
import { DATE_ADD_INTERVALS } from "@/lib/domain/expression/types";
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
import { printCsql } from "../../csql/print";
import { checkCsqlRepresentability } from "../../csql/representability";
import type { CsqlNode } from "../../csql/tree";
import type { EmissionRewriteId } from "../../emissionRewrites";
import { caseListStepDatumId } from "../../formLinkProjection";
import { lookupWireNaming } from "../../lookup/naming";
import { searchWireShape } from "../../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../../suite/case-search/types";
import { type FormSyntax, readFormSyntax } from "../../xpath/formSyntax";
import {
	CSQL_QUERY_FUNCTIONS,
	CSQL_VALUE_FUNCTIONS,
} from "../../xpath/functionCapabilities";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import type { PendingExpression } from "../pendingExpressions";
import { sameSyntax } from "../syntaxCompare";
import {
	checkErrorEntry,
	EXPRESSION_CLAIMS,
	parseIssueEntry,
} from "./findings";
import { shapedLiteral } from "./folds";
import type { ExpressionReadEnv } from "./index";
import { bindSlot } from "./readExpression";

export type SearchRowReading =
	| {
			readonly ok: true;
			readonly predicate: Expression;
			readonly level: "exact" | "guards";
			readonly rewrites: readonly EmissionRewriteId[];
	  }
	| {
			readonly ok: false;
			readonly claim: {
				readonly entryId: string;
				readonly detail: FindingDetail;
			};
	  }
	| { readonly ok: false; readonly unrecognized: true };

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
const M7 = C["xpath-query-condition-outside-what-nova-types"].entry;
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
	if (at.kind !== "call" || at.name !== "instance") return false;
	return stringOf(at.args[0])?.startsWith("search-input") === true;
}

/** The table of the plan's section 7.2, over the wrapper's syntax tree: the
 *  constant text the wrapper builds, the values the device splices in, and
 *  the choices it makes. */
function skeleton(wrapper: FormSyntax, root = true): readonly SkeletonPart[] {
	const node = bare(wrapper);
	if (node.kind === "string") return [{ kind: "text", text: node.value }];
	if (node.kind === "call" && node.name === "concat")
		return node.args.flatMap((arg) => skeleton(arg, false));
	const choice = callOf(node, "if", 3);
	if (choice !== undefined) {
		const [condition, thenArg, elseArg] = choice.args as [
			FormSyntax,
			FormSyntax,
			FormSyntax,
		];
		const count = callOf(condition, "count", 1);
		if (
			root &&
			count !== undefined &&
			readsSearchAnswer(count.args[0] as FormSyntax) &&
			stringOf(elseArg) === "match-all()"
		)
			return [
				{
					kind: "presence",
					input: count.args[0] as FormSyntax,
					body: skeleton(thenArg, true),
				},
			];
		if (stringOf(thenArg) === "match-none()") return skeleton(elseArg, root);
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
				stringOf(inner.args[1]) === "match-none()"
			)
				return skeleton(elseArg, root);
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
				then: skeleton(thenArg, false),
				otherwise: skeleton(elseArg, false),
				node,
			},
		];
	}
	return [{ kind: "hole", node, quoted: false }];
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
};
type Bound = Expression | Refusal | { readonly unrecognized: true };

class Stop {
	constructor(readonly outcome: Refusal | { readonly unrecognized: true }) {}
}
function refuseWith(entryId: string, reason: string): never {
	throw new Stop({ entryId, detail: { name: "_xpath_query", reason } });
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
	 *  a date and time as `eq`, a literal's tokens as several choices. */
	readonly proposals: boolean;
	/** Whether the row's text called `today()`, HQ's server-side day. */
	today: boolean;
}

const COMPARISONS: Readonly<Record<string, ComparisonKind>> = {
	"=": "eq",
	"!=": "neq",
	">": "gt",
	">=": "gte",
	"<": "lt",
	"<=": "lte",
};
const ORDERINGS: ReadonlySet<string> = new Set([">", ">=", "<", "<="]);
const MATCH_MODES: Readonly<
	Record<string, Extract<Expression, { kind: "match" }>["mode"]>
> = {
	"starts-with": "starts-with",
	"fuzzy-match": "fuzzy",
	"phonetic-match": "phonetic",
	"fuzzy-date": "fuzzy-date",
};

/** Whether HQ orders by a text: a number `float()` reads, or a date or a
 *  date and time its parsers read. */
function orderable(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed !== "" && Number.isFinite(Number(trimmed))) return true;
	const shape = literalShape(text);
	return shape !== undefined && shape.type !== "time";
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
	const value = bound.bound.candidate;
	const query = deviceQuery(value);
	if (query !== undefined) refuseWith(DEVICE_QUERY, query);
	return value;
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
			generatedValues: new Map(),
			operationIdPaths: new Map(),
			recordDialect: () => undefined,
			entryFactsRefused: new Set(),
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
		const at = bare(node);
		const choice = markerAt(at, this.markers);
		if (choice !== undefined) {
			if (choice.kind !== "choice")
				refuseWith(RUNTIME_NAMES, "csql:hole-as-query");
			return this.choice(choice, rowType);
		}
		switch (at.kind) {
			case "binary": {
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
				const kind = COMPARISONS[at.op];
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
		return {
			kind: "if",
			cond: bindDevice(part.condition, this.state),
			// biome-ignore lint/suspicious/noThenProperty: an expression branch, never awaited.
			then: thenQuery,
			else: otherwise,
		};
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
			if (right.kind !== "number")
				return {
					kind,
					left: count,
					right: this.value(rightNode, count, false, rowType),
				};
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
			const destination = relationDestination(this.state.env.doc, rowType, {
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
					via: ancestorId as [RelationStep, ...RelationStep[]],
				},
				where: {
					kind: "eq",
					left,
					right: this.value(rightNode, left, false, rowType),
				},
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
				refuseWith(UNTYPED_RIGHT_SIDE, "csql:untyped-right-side");
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
			!sameNode(left.left, right.left) ||
			!sameNode(left.right, right.right)
		)
			return undefined;
		const anchor = this.anchor(bare(left.left), rowType);
		if (scalarDataType(typeOf(anchor, this.state.context)?.data) !== "datetime")
			return undefined;
		return {
			kind: "eq",
			left: anchor,
			right: this.value(left.right, anchor, false, rowType),
		};
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
				!COMPARISONS[at.op]
			)
				refuseWith(HQ_REFUSES, "csql:arithmetic");
			unrecognizedRow();
		}
		const last = path[path.length - 1] as { name: string; attribute: boolean };
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
		if (marker !== undefined) {
			if (marker.kind !== "hole")
				refuseWith(RUNTIME_NAMES, "csql:choice-as-value");
			return bindDevice(marker.node, this.state);
		}
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
		if (pieces.length === 1 && pieces[0]?.kind === "text")
			return term(
				shapedLiteral(value, opposite, this.state.context, ordering) as Literal,
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
			const part = this.markers.get(first.marker);
			if (part?.kind !== "hole")
				refuseWith(RUNTIME_NAMES, "csql:choice-in-string");
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
				this.state.today = true;
				return { kind: "today" };
			case "now":
				if (args.length !== 0) unrecognizedRow();
				return { kind: "now" };
			case "date":
			case "datetime":
			case "double": {
				if (args.length !== 1) unrecognizedRow();
				const inner = this.value(
					args[0] as FormSyntax,
					undefined,
					false,
					rowType,
				);
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
				return {
					kind: "date-add",
					date: this.value(args[0] as FormSyntax, undefined, false, rowType),
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
			items = JSON.parse(json);
		} catch {
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
				const inner = this.query(args[0] as FormSyntax, rowType);
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
					mode: MATCH_MODES[at.name] as Extract<
						Expression,
						{ kind: "match" }
					>["mode"],
				};
			}
			case "within-distance": {
				if (args.length !== 4) unrecognizedRow();
				const property = this.propertyArgument(args[0] as FormSyntax, rowType);
				const center = this.value(
					args[1] as FormSyntax,
					undefined,
					false,
					rowType,
				);
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
				quantifier,
			};
		}
		return {
			kind: "multi-select-contains",
			property,
			values: [this.value(valueNode, undefined, false, rowType)],
			quantifier,
		};
	}

	/** `@case_type = 'T' and (q)`, the type test the emitter writes into a
	 *  relation's filter: T and q. */
	typedFilter(node: FormSyntax | undefined): {
		readonly caseType?: string;
		readonly filter?: FormSyntax;
	} {
		if (node === undefined) return {};
		const at = bare(node);
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
				return { caseType: stringOf(test.right) as string, filter: at.right };
		}
		return { filter: at };
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
		} catch {
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
		if (stop instanceof Stop) return stop.outcome;
		throw stop;
	}
}

/** Section 7.3: assembles each run of text and holes, parses it with
 *  `readFormSyntax` and binds it under `context`; a `presence` or `choice`
 *  part binds its bodies by the same call. */
function bindCsql(
	parts: readonly SkeletonPart[],
	context: ExpressionContext,
	env: SearchRowEnv,
	options: { readonly text: string; readonly proposals: boolean },
): { readonly bound: Bound; readonly today: boolean } {
	const state: BindState = {
		context,
		env,
		text: options.text,
		prefix: markerPrefix(constantTexts(parts)),
		proposals: options.proposals,
		today: false,
	};
	const bound = bindCsqlParts(parts, state, rowCaseType(context));
	return { bound, today: state.today };
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
	const wire = config === undefined ? undefined : searchWireShape(config);
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

/** The candidate's CSQL as text with markers, and the device value each stands for. */
interface CandidateText {
	readonly text: string;
	readonly holes: readonly WireExpr[];
	readonly today: boolean;
	/** A hole or an obligation besides the device's day. */
	readonly guarded: boolean;
}

function isTodayCall(wire: WireExpr): boolean {
	return wire.k === "call" && wire.fn === "today" && wire.args.length === 0;
}

function candidateText(
	tree: CsqlNode,
	prefix: string,
): CandidateText | undefined {
	const segments = printCsql(tree);
	let text = "";
	const holes: WireExpr[] = [];
	let today = false;
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
			text = `${text.slice(0, -1)}today()`;
			segments[index + 1] = { kind: "constant", text: next.text.slice(1) };
			today = true;
			continue;
		}
		guarded = true;
		mark(segment.value);
	}
	return { text, holes, today, guarded };
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

/** Guards: the same CSQL and, hole for hole, the same device values. */
function guards(
	parts: readonly SkeletonPart[],
	tree: CsqlNode,
	prefix: string,
): { readonly today: boolean; readonly guarded: boolean } | undefined {
	const [only] = parts;
	if (parts.length === 1 && only?.kind === "presence") {
		if (tree.k !== "presence") return undefined;
		const trigger = printed(tree.trigger);
		if (trigger === undefined || !sameNode(only.input, trigger))
			return undefined;
		const inner = guards(only.body, tree.clause, prefix);
		return inner === undefined ? undefined : { ...inner, guarded: true };
	}
	if (tree.k === "presence") return undefined;
	const source = sourceText(parts, prefix);
	const candidate = candidateText(tree, prefix);
	if (source === undefined || candidate === undefined) return undefined;
	if (source.holes.length !== candidate.holes.length) return undefined;
	const left = readFormSyntax(source.text);
	const right = readFormSyntax(candidate.text);
	if (
		!left.ok ||
		!right.ok ||
		left.node === undefined ||
		right.node === undefined
	)
		return undefined;
	if (!sameNode(left.node, right.node)) return undefined;
	for (let index = 0; index < source.holes.length; index++) {
		const hole = printed(candidate.holes[index] as WireExpr);
		if (
			hole === undefined ||
			!sameNode(source.holes[index] as FormSyntax, hole)
		)
			return undefined;
	}
	return { today: candidate.today, guarded: candidate.guarded };
}

/** The checker's and representability's refusal of a bound row, as its claim. */
function refusalOf(
	candidate: Expression,
	context: ExpressionContext,
	env: SearchRowEnv,
	text: string,
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
		const pending: PendingExpression = {
			ref: context.slot,
			text,
			mode: { target: "search-row" },
			place: { kind: "app" },
			key: "csql-key:_xpath_query",
		};
		const answer = checkErrorEntry(first, env.doc, pending, candidate);
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

/** One `_xpath_query` value read under the context of the slot the caller
 *  proposes: the case list filter's, or an advanced Search field's. */
export function readSearchFilterRow(
	text: string,
	context: ExpressionContext,
	env: SearchRowEnv,
): SearchRowReading {
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch {
		return { ok: false, unrecognized: true };
	}
	if (!read.ok || read.node === undefined)
		return { ok: false, unrecognized: true };
	const source = read.node;
	const parts = skeleton(source);
	const prefix = markerPrefix(constantTexts(parts));
	const emission = emissionContext(context, env);
	let firstRefusal: Refusal | undefined;
	for (const proposals of [true, false]) {
		const { bound, today } = bindCsql(parts, context, env, { text, proposals });
		if ("unrecognized" in bound) return { ok: false, unrecognized: true };
		if (!("kind" in bound)) return { ok: false, claim: bound };
		const refusal = refusalOf(bound, context, env, text);
		if (refusal !== undefined) {
			firstRefusal ??= refusal;
			continue;
		}
		let tree: CsqlNode;
		try {
			if (exact(source, bound, emission))
				return { ok: true, predicate: bound, level: "exact", rewrites: [] };
			tree = emitCsqlTree(bound, emission);
		} catch {
			continue;
		}
		const level = guards(parts, tree, prefix);
		if (level === undefined) continue;
		const rewrites: EmissionRewriteId[] = [];
		if (level.guarded || !(today && level.today))
			rewrites.push("search-value-guards");
		if (today && level.today) rewrites.push("search-today-device-day");
		return { ok: true, predicate: bound, level: "guards", rewrites };
	}
	if (firstRefusal !== undefined) return { ok: false, claim: firstRefusal };
	return { ok: false, unrecognized: true };
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
	const parts = skeleton(source);
	try {
		if (exact(source, predicate, emission)) return "exact";
		return guards(
			parts,
			emitCsqlTree(predicate, emission),
			markerPrefix(constantTexts(parts)),
		) === undefined
			? undefined
			: "guards";
	} catch {
		return undefined;
	}
}

/** A row's CSQL as HQ's search reads it, with the holes in it: the parsed
 *  text the surface uses read, and each marker's device node. Undefined
 *  where the text is no CSQL the grammar reads. */
export function searchRowCsql(wrapper: FormSyntax):
	| {
			readonly csql: FormSyntax;
			readonly holes: ReadonlyMap<string, FormSyntax>;
			readonly presence: boolean;
	  }
	| undefined {
	let parts = skeleton(wrapper);
	const [only] = parts;
	const presence = parts.length === 1 && only?.kind === "presence";
	if (presence && only?.kind === "presence") parts = only.body;
	const prefix = markerPrefix(constantTexts(parts));
	const assembled = assemble(parts, prefix);
	const csql = readFormSyntax(assembled.text);
	if (!csql.ok || csql.node === undefined) return undefined;
	const holes = new Map<string, FormSyntax>();
	for (const { marker, part } of assembled.markers)
		holes.set(marker, part.node);
	return { csql: csql.node, holes, presence };
}
