/**
 * The canonical tree of a Nova document. Two trees can print the same bytes
 * in one slot (an `or` of equalities and an `in`, a read spelled absolute and
 * one with no spelling); the reader gives the folded one, so a read of Nova's
 * own export is compared with this form of the document, defined here
 * independently of the reader. Each row is a rewrite over the typed tree
 * between two trees that print the same bytes, which a test prints in a real
 * slot. Nothing here parses or prints.
 */
import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import {
	type ExpressionChildRole,
	expressionChildren,
} from "@/lib/domain/expression/children";
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import {
	activeRowScope,
	type ExpressionContext,
} from "@/lib/domain/expression/context";
import {
	type CsqlPositionMap,
	csqlPositionAt,
	csqlPositions,
	isCsqlQueryAnchor,
	isRuntimeSubtreeRoot,
	readsSearchRow,
} from "@/lib/domain/expression/csqlPositions";
import { distanceToMeters } from "@/lib/domain/expression/distance";
import { formNodeGraph } from "@/lib/domain/expression/formNodes";
import {
	coercesToDay,
	comparisonOperands,
	comparisonPlan,
	instantOperand as domainInstantOperand,
	instantOperandMember,
	instantTextOfMicros,
	literalInstantMicros,
	literalInstantText,
	loweredComparisonMembers,
} from "@/lib/domain/expression/instantOperand";
import { mapExpressionChildren } from "@/lib/domain/expression/mapAst";
import {
	canonicalizeRelationPath,
	normalizeRelationEvaluationScopes,
} from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import {
	effectiveFilterForEmission,
	simplifyForEmission,
} from "@/lib/domain/expression/simplify";
import {
	expressionContextAtPath,
	expressionRowScope,
	scalarDataType,
	typeOf,
	visitAssignmentOutputs,
} from "@/lib/domain/expression/typeChecker";
import {
	type CheckPath,
	type Expression,
	type FormNodeRef,
	isRelationPath,
	type Literal,
	type RelationPath,
	type SwitchCase,
	type Term,
} from "@/lib/domain/expression/types";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain/forms";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { Uuid } from "@/lib/domain/uuid";
import { userPropertySlugVerdict } from "../../validator/userPropertySlug";
import { rethrowWorkStop } from "../../workMeter";
import type { FormNodeProjection } from "../../xpath/formNodeProjection";
import { crossesSourceRepeatInRowPredicate } from "../../xpath/wire/formReads";
import { mayHoldInstantText } from "../../xpath/wire/instant";
import { literalArguments } from "../../xpath/wire/serialize";
import type { WireMode } from "../../xpath/wire/tree";
import { sameJson } from "../jsonCursor";
import { shapedLiteral as shapedLiteralText, untextualType } from "./folds";

/** What the emitter's print of the slot binds beside its context: the
 *  questions whose read prints as the path the emitter binds it to, whatever
 *  its spelling, where `xform/caseOps.ts` prints the slot from a Save to Case
 *  block's node, and every question of the form in a select's choices from a
 *  table or from cases (`bindLookupFilterFieldPaths`;
 *  `readExpression.ts::slotPrintUnder`). */
export interface SlotPrint {
	readonly boundFields?: ReadonlySet<Uuid>;
}

/**
 * The production print a caller holds of the slot whose tree is canonicalized, which holds the
 * rows to their contract where they are applied: the slot keeps what it printed with the tree as
 * given, the rows' whole result where it prints so, and otherwise each rewrite only where the
 * slot, with the rewritten node in place, prints so (`canonicalExpression`). `print`
 * is the slot's print with `expression` as its tree, undefined where the emitter refuses that
 * tree; a slot whose own tree has no print holds the rows as they are. `withheld` is told the id of
 * each row a print refused, a row whose two members print differently there, which is Nova's
 * own defect.
 */
export interface RewriteGuard {
	print(expression: Expression): string | undefined;
	withheld(rowId: string): void;
}

/** One row: a tree shape and the canonical tree that prints the same bytes
 *  in this slot. `at.root` says the node is the slot's whole tree, and
 *  `at.print` what the slot's print binds. */
export interface PrintCollision {
	readonly id: string;
	rewrite(
		node: Expression,
		context: ExpressionContext,
		at: {
			readonly root: boolean;
			readonly print: SlotPrint;
			/** The node's path in the slot's tree, and that tree as given. */
			readonly path: CheckPath;
			readonly tree: Expression;
		},
	): Expression | undefined;
}

const COMPARISON_KINDS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const ORDERING_KINDS = new Set(["gt", "gte", "lt", "lte"]);
/** Each comparison with its two sides swapped. */
const MIRRORED_COMPARISONS = {
	eq: "eq",
	neq: "neq",
	gt: "lt",
	gte: "lte",
	lt: "gt",
	lte: "gte",
} as const;
type Comparison = Extract<
	Expression,
	{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
>;
function isComparison(node: Expression): node is Comparison {
	return COMPARISON_KINDS.has(node.kind);
}

/** `node`, an `if` that tests one subject against a literal at two or more
 *  levels of its `else` chain (a `switch` on that subject at the end of the
 *  chain among them), as that one `switch`: a device and CSQL print each case
 *  of a `switch` as the `if` of its test, so both print the same. The one
 *  reading of such a chain, the canonical row `switch`'s and the CSQL
 *  reader's (`csqlRead.ts`) alike; `node` itself where it is no such chain. */
export function switchOfIfChain(node: Expression): Expression {
	const cases: SwitchCase[] = [];
	let on: Expression | undefined;
	let at: Expression = node;
	while (at.kind === "if" && at.cond.kind === "eq") {
		const when = termOf(at.cond.right);
		if (when?.kind !== "literal") break;
		if (on === undefined) on = at.cond.left;
		else if (!sameJson(on, at.cond.left)) break;
		// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
		cases.push({ when, then: at.then });
		at = at.else;
	}
	if (on !== undefined && at.kind === "switch" && sameJson(at.on, on)) {
		cases.push(...at.cases);
		at = at.fallback;
	}
	const [head, ...rest] = cases;
	return on === undefined || head === undefined || rest.length === 0
		? node
		: { kind: "switch", on, cases: [head, ...rest], fallback: at };
}

function termOf(node: Expression): Term | undefined {
	return node.kind === "term" ? node.term : undefined;
}

/** `value`, a text, as the choices of the question `opposite` reads where it
 *  names them and they print as the same text; undefined otherwise. */
function choiceOf(
	value: Expression,
	opposite: Expression,
	context: ExpressionContext,
): Expression | undefined {
	const literal = termOf(value);
	const other = termOf(opposite);
	if (
		literal?.kind !== "literal" ||
		typeof literal.value !== "string" ||
		literal.data_type !== undefined ||
		other?.kind !== "field" ||
		other.role !== undefined
	)
		return undefined;
	const field = context.form?.fields.get(other.uuid);
	const choices = field?.choices;
	if (field === undefined || choices?.kind !== "inline") return undefined;
	const values =
		field.kind === "multi_select"
			? literal.value.split(/\s+/u).filter(Boolean)
			: [literal.value];
	const options = values.map(
		(selected) =>
			choices.options.find((option) => option.value === selected)?.uuid,
	);
	const [first, ...rest] = options;
	if (
		first === undefined ||
		rest.some((uuid) => uuid === undefined) ||
		values.join(" ") !== literal.value
	)
		return undefined;
	return {
		kind: "term",
		term: {
			kind: "choice",
			field: other.uuid,
			options: [first, ...(rest as Uuid[])],
		},
	};
}

type Selection = Extract<Expression, { kind: "multi-select-contains" }>;

/** A test of one value, `selected(q, v)`, its fixed value named as the
 *  choices of the question `q` reads where it names them: the form parser
 *  binds such a test so (`expressionAst.ts::choiceFor`). */
function choiceSelection(
	node: Selection,
	context: ExpressionContext,
): Selection | undefined {
	if (node.values.length !== 1) return undefined;
	const [only] = node.values;
	if (only?.kind !== "literal" || node.property.kind === "prop")
		return undefined;
	const choice = choiceOf(
		{ kind: "term", term: only },
		node.property as Expression,
		context,
	);
	return choice?.kind === "term"
		? { ...node, values: [choice.term] as Selection["values"] }
		: undefined;
}

/** Whether the slot's tree prints as CSQL: a Search field's condition, and a
 *  list filter its search restates, where the reader takes the restating
 *  row's spelling of a clause that prints the list's filter alike
 *  (`search/rows.ts`). */
function printsCsql(context: ExpressionContext): boolean {
	return (
		context.slot.slot === "search_input_predicate" ||
		(context.slot.slot === "case_list_filter" &&
			context.profile.targets.has("CS"))
	);
}

/** A value a selection test prints as text: a literal or a choice. */
function fixedValue(value: Selection["values"][number]): boolean {
	return value.kind === "literal" || value.kind === "choice";
}

/** `node`, an `or` or an `and` of one-value selection tests of one case
 *  property, as the one selection CSQL prints in the same bytes, parenthesized
 *  (`csql/emitter.ts::selection`): each fixed value `selected`, and a value
 *  worked out on the device `selected-any` in an `or` and `selected-all` in
 *  an `and`. The search row reader reads such a parenthesized join as that
 *  selection (`csqlRead.ts::CsqlBinder.selectionGroup`). */
function joinedSelection(node: Expression): Selection | undefined {
	if ((node.kind !== "or" && node.kind !== "and") || node.clauses.length < 2)
		return undefined;
	const quantifier = node.kind === "or" ? "any" : "all";
	const values: Selection["values"][number][] = [];
	let property: Selection["property"] | undefined;
	for (const clause of node.clauses) {
		if (
			clause.kind !== "multi-select-contains" ||
			clause.property.kind !== "prop" ||
			clause.values.length !== 1 ||
			(property !== undefined && !sameJson(property, clause.property))
		)
			return undefined;
		const [value] = clause.values;
		if (
			value === undefined ||
			(fixedValue(value)
				? clause.quantifier !== "any"
				: clause.quantifier !== quantifier)
		)
			return undefined;
		property = clause.property;
		values.push(value);
	}
	const [first, ...rest] = values;
	return property === undefined || first === undefined
		? undefined
		: {
				kind: "multi-select-contains",
				property,
				values: [first, ...rest],
				quantifier,
			};
}

/** `node`, an `or` of two or more equalities of one operand with a literal,
 *  as the membership of those literals. */
function joinedMembership(node: Expression): Expression | undefined {
	if (node.kind !== "or" || node.clauses.length < 2) return undefined;
	const first = node.clauses[0];
	if (first?.kind !== "eq") return undefined;

	const values: Literal[] = [];
	for (const clause of node.clauses) {
		if (clause.kind !== "eq" || !sameJson(clause.left, first.left))
			return undefined;
		const literal = termOf(clause.right);
		if (literal?.kind !== "literal") return undefined;
		values.push(literal);
	}
	const [head, ...rest] = values;
	return head === undefined
		? undefined
		: { kind: "in", left: first.left, values: [head, ...rest] };
}

/** `node` as the one Nova node CSQL prints in the same bytes, parenthesized:
 *  a selection (`joinedSelection`) or a membership (`csql/emitter.ts::membership`
 *  joins its equalities with `or` inside parentheses). The search row reader
 *  reads such a parenthesized join as that node
 *  (`csqlRead.ts::CsqlBinder.parenthesizedJoin`). */
function parenthesizedJoin(node: Expression): Expression | undefined {
	return joinedSelection(node) ?? joinedMembership(node);
}

/** A clause of an `and` with every `or` the CSQL printer parenthesizes
 *  there, its own or a branch's of a choice the device makes (a Search
 *  field's presence, an `if`), which print at the `and`'s precedence, as the
 *  one node it prints the bytes of (`parenthesizedJoin`). */
function joinsInConjunction(node: Expression): Expression {
	if (node.kind === "or") return parenthesizedJoin(node) ?? node;
	if (node.kind === "when-input-present") {
		const clause = joinsInConjunction(node.clause);
		return clause === node.clause ? node : { ...node, clause };
	}
	if (node.kind === "if") {
		const then = joinsInConjunction(node.then);
		const otherwise = joinsInConjunction(node.else);
		if (then === node.then && otherwise === node.else) return node;
		return { ...node, then, else: otherwise };
	}
	return node;
}

function stringLiteral(node: Expression | undefined): string | undefined {
	const term = node === undefined ? undefined : termOf(node);
	return term?.kind === "literal" && typeof term.value === "string"
		? term.value
		: undefined;
}

function numberLiteral(node: Expression | undefined): number | undefined {
	const term = node === undefined ? undefined : termOf(node);
	return term?.kind === "literal" && typeof term.value === "number"
		? term.value
		: undefined;
}

function isCall(
	node: Expression | undefined,
	fn: string,
	arity?: number,
): node is Extract<Expression, { kind: "call" }> {
	return (
		node?.kind === "call" &&
		node.fn === fn &&
		(arity === undefined || node.args.length === arity)
	);
}

/** The slot's own form-node graph, as the read relocation reads it. */
function graphProjection(
	context: ExpressionContext,
): FormNodeProjection | undefined {
	if (context.form === undefined) return undefined;
	return {
		graph: formNodeGraph(context.form),
		step: () => undefined,
		path: () => undefined,
	};
}

type FormRead = Extract<Term, { kind: "field" | "repeat-row" }>;
function formRead(node: Expression): FormRead | undefined {
	const term = termOf(node);
	return term?.kind === "field" || term?.kind === "repeat-row"
		? term
		: undefined;
}

/** Whether a question read sits at one of the two relocation sites, and
 *  which: a `default_value` slot, or a row predicate crossing a repeat the
 *  slot is in. */
function relocationSite(
	read: FormRead,
	context: ExpressionContext,
	print: SlotPrint,
): "default" | "row-predicate" | undefined {
	if (boundRead(read, print)) return undefined;
	const projection = graphProjection(context);
	const target: FormNodeRef =
		read.kind === "field"
			? {
					kind: "field",
					uuid: read.uuid,
					...(read.role === undefined ? {} : { role: read.role }),
				}
			: { kind: "repeat-row", repeat: read.repeat, attribute: read.attribute };
	const coordinates = projection?.graph.path(target);
	if (
		projection !== undefined &&
		coordinates !== undefined &&
		crossesSourceRepeatInRowPredicate(coordinates, context, projection)
	)
		return "row-predicate";
	return context.slot.entity === "field" &&
		context.slot.slot === "default_value"
		? "default"
		: undefined;
}

/** Whether a read prints as the path the slot's print binds its question to,
 *  whatever its spelling: a question read with no role and no filter
 *  (`fromExpression.ts` prints such a read as its binding). */
function boundRead(read: FormRead, print: SlotPrint): boolean {
	return (
		read.kind === "field" &&
		read.role === undefined &&
		read.filters === undefined &&
		print.boundFields?.has(read.uuid) === true
	);
}

function withSpelling(
	read: FormRead,
	spelling: "current" | undefined,
): Expression {
	const { spelling: _old, ...rest } = read;
	return {
		kind: "term",
		term: (spelling === undefined ? rest : { ...rest, spelling }) as Term,
	};
}

/** A literal typed by its own shape where it stands against a date or a
 *  date and time, or in an ordering against a value of no known type. */
function shapedLiteral(
	literal: Literal,
	opposite: Expression | undefined,
	context: ExpressionContext,
	ordering: boolean,
): Literal {
	if (literal.data_type !== undefined || typeof literal.value !== "string")
		return literal;
	const typed = shapedLiteralText(literal.value, opposite, context, ordering);
	return typed.data_type === undefined
		? literal
		: { ...literal, data_type: typed.data_type };
}

/** The mode the slot prints in, from its context: a validation condition,
 *  another XForm attribute, or an HQ JSON slot under its interpolation. */
function modeOf(context: ExpressionContext): WireMode {
	const slot = context.slot;
	if (slot.entity === "field")
		return { target: "xform", constraint: slot.slot === "validate" };
	if (slot.entity === "form") {
		if (slot.slot === "form_display_condition")
			return {
				target: "hq-json",
				interpolation:
					context.form !== undefined &&
					CASE_LOADING_FORM_TYPES.has(context.form.type)
						? "case"
						: "no-case",
			};
		if (
			slot.slot === "form_link_condition" ||
			slot.slot === "form_link_datum_xpath"
		)
			return { target: "hq-json", interpolation: "none" };
		return { target: "xform", constraint: false };
	}
	switch (slot.slot) {
		case "module_display_condition":
		case "search_input_required_when":
			return { target: "hq-json", interpolation: "no-case" };
		case "case_list_filter":
			return { target: "hq-json", interpolation: "case" };
		case "search_input_validation_rule":
			return { target: "hq-json", interpolation: "no-dots" };
		default:
			return { target: "hq-json", interpolation: "none" };
	}
}

/** The slots whose emission drops boolean identities. */
function simplifiedSlot(context: ExpressionContext): boolean {
	const slot = context.slot;
	if (slot.entity === "field") return slot.slot === "lookup_options_source";
	if (slot.entity !== "module") return false;
	return (
		slot.slot === "case_list_filter" ||
		slot.slot === "search_button_display_condition" ||
		slot.slot === "search_input_predicate" ||
		slot.slot === "search_input_options"
	);
}

function relitText(node: Expression, text: string | undefined): Expression {
	const term = termOf(node);
	if (text === undefined || term?.kind !== "literal") return node;
	return text === term.value
		? node
		: { kind: "term", term: { ...term, value: text } };
}

/** The texts of the arguments a literal prints as inside a `concat`. */
function literalTexts(value: string, mode: WireMode): string[] {
	return literalArguments(value, mode, true).map((arg) => arg.text);
}

/** Whether `node` is a text literal that prints alone as a `concat` of the
 *  very arguments it prints as inside one, so `concat(<node>)` and `<node>`
 *  print the same bytes. */
function printsAsItsOwnConcat(node: Expression, mode: WireMode): boolean {
	const text = stringLiteral(node);
	if (text === undefined) return false;
	const tokens = (keepEmptyQuotePieces: boolean) =>
		literalArguments(text, mode, keepEmptyQuotePieces).map((arg) => arg.token);
	const alone = tokens(false);
	return alone.length > 1 && sameJson(alone, tokens(true));
}

/** The property a query of the worker's own case reads: the `casedb` row
 *  of type `commcare-user` whose `hq_user_id` is the session's user. */
function usercaseProjection(node: Expression): string | undefined {
	if (node.kind !== "project" || node.value.kind !== "prop") return undefined;
	const { of, value } = node;
	if (
		of.kind !== "cases" ||
		of.source !== "casedb" ||
		of.where.length !== 2 ||
		value.via !== undefined
	)
		return undefined;
	const [typed, keyed] = of.where;
	if (typed?.kind !== "eq" || keyed?.kind !== "eq") return undefined;
	const rowType = termOf(typed.left);
	const caseType = termOf(typed.right);
	const key = termOf(keyed.left);
	const user = termOf(keyed.right);
	return rowType?.kind === "case-row-type" &&
		caseType?.kind === "case-type" &&
		caseType.caseType === USERCASE_TYPE &&
		key?.kind === "prop" &&
		key.property === "hq_user_id" &&
		key.via === undefined &&
		user?.kind === "session-context" &&
		user.field === "userid"
		? value.property
		: undefined;
}

/** The worker leaf of a slug read from `source`: the app's worker property of
 *  that slug by identity where the app holds exactly one, else the
 *  name-backed read, as the parser binds `#user/<slug>` and the session's
 *  `user/data/<slug>` (`xpath/referenceBindings.ts::formUserProperty`). */
function workerLeaf(
	slug: string,
	context: ExpressionContext,
	source: "worker-record" | undefined,
): Term {
	const held = workerPropertyNamed(slug, context.facts.userPropertySlugs);
	const provenance = source === undefined ? {} : { source };
	return held !== undefined
		? {
				kind: "session-user-property",
				userPropertyUuid: held,
				...provenance,
			}
		: { kind: "session-user", field: slug, ...provenance };
}

/**
 * The worker property a read of `slug` by name prints as, as the parser binds
 * `#user/<slug>` (`xpath/referenceBindings.ts::formUserProperty`): the one
 * property whose slug is `slug` in any letters, where it is exactly `slug`
 * and `slug` is a valid slug; otherwise none, and the read stays by name.
 */
export function workerPropertyNamed(
	slug: string,
	slugs: ReadonlyMap<Uuid, string>,
): Uuid | undefined {
	const matches = [...slugs].filter(
		([, held]) => held.toLowerCase() === slug.toLowerCase(),
	);
	const [only] = matches;
	return matches.length === 1 &&
		only !== undefined &&
		only[1] === slug &&
		userPropertySlugVerdict(slug, NO_SLUGS).ok
		? only[0]
		: undefined;
}

/** The worker-record leaf of a slug, as the parser binds `#user/<slug>`. */
function workerRecordLeaf(slug: string, context: ExpressionContext): Term {
	return workerLeaf(slug, context, "worker-record");
}
const NO_SLUGS: ReadonlySet<string> = new Set();
const USERCASE_TYPE = "commcare-user";

const INSTANT_TEXT_PATTERN = "%Y-%m-%dT%H:%M:%S.%3%Z";

/** The operand text an instant parse reads: the first argument of the
 *  `substr` inside its fraction term (`instant.ts::instantMicros`), where
 *  `side` is that parse. */
function instantParseOperand(side: Expression): Expression | undefined {
	if (side.kind !== "arith" || side.op !== "+") return undefined;
	const fraction = side.right;
	if (fraction.kind !== "if" || fraction.cond.kind !== "match")
		return undefined;
	const test = fraction.cond;
	if (test.mode !== "starts-with") return undefined;
	const tail = test.property as Expression;
	return isCall(tail, "substr") ? tail.args[0] : undefined;
}

/** One side of a lowered comparison as the comparison's own operand: the
 *  parse's text unwrapped by the spellings `instant.ts::leafText` and
 *  `::operandText` write, a folded literal as its canonical text, or a day
 *  number's microseconds as its moment. */
function instantSide(
	whole: Expression,
	text: Expression | undefined,
	record: boolean,
): Expression | undefined {
	if (text !== undefined) return instantOperand(text, record);
	const micros = numberLiteral(whole);
	if (micros !== undefined && Number.isInteger(micros)) {
		const literal = instantTextOfMicros(micros);
		if (literal === undefined || literalInstantMicros(literal) !== micros)
			return undefined;
		return {
			kind: "term",
			term: record
				? { kind: "literal", value: literal, data_type: "datetime" }
				: { kind: "literal", value: literal },
		};
	}
	if (
		record &&
		whole.kind === "arith" &&
		whole.op === "*" &&
		numberLiteral(whole.right) === 86_400_000_000
	)
		return { kind: "datetime-coerce", value: whole.left };
	return undefined;
}

function instantOperand(text: Expression, record: boolean): Expression {
	const coerce = (value: Expression): Expression =>
		record ? { kind: "datetime-coerce", value } : text;
	const literal = stringLiteral(text);
	if (literal !== undefined)
		return {
			kind: "term",
			term: record
				? { kind: "literal", value: literal, data_type: "datetime" }
				: { kind: "literal", value: literal },
		};
	if (
		text.kind === "format-date" &&
		text.pattern === INSTANT_TEXT_PATTERN &&
		text.date.kind === "coalesce" &&
		text.date.values.length === 2 &&
		stringLiteral(text.date.values[1]) === ""
	)
		return text.date.values[0];
	if (
		text.kind === "concat" &&
		text.parts.length === 2 &&
		stringLiteral(text.parts[1])?.startsWith("T00:00:00") === true
	) {
		const day = text.parts[0];
		if (day.kind === "format-date") {
			if (day.date.kind === "coalesce" && day.date.values.length === 2)
				return coerce(day.date.values[0]);
			if (day.date.kind === "date-coerce") return coerce(day.date.value);
		}
		return coerce(day);
	}
	if (text.kind === "if") {
		const { cond } = text;
		if (
			cond.kind === "eq" &&
			isCall(cond.left, "string-length", 1) &&
			numberLiteral(cond.right) === 10 &&
			sameJson(cond.left.args[0], text.else)
		)
			return coerce(text.else);
		if (
			cond.kind === "eq" &&
			stringLiteral(cond.right) === "" &&
			stringLiteral(text.then) === ""
		)
			return instantOperand(text.else, record);
		return {
			kind: "if",
			cond,
			// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
			then: instantOperand(text.then, record),
			else: instantOperand(text.else, record),
		};
	}
	if (text.kind === "coalesce") {
		const [first, ...rest] = text.values.map((value) =>
			instantOperand(value, record),
		);
		if (first !== undefined)
			return { kind: "coalesce", values: [first, ...rest] };
	}
	return text;
}

/** `node` with each `datetime-coerce` of a literal a device folds
 *  (`instantOperand.ts`, class `literal-instant`) as the date-and-time
 *  literal of the text it prints, where `folds` holds: at the slot's root,
 *  as an operand of a comparison a device does not make by day, as the date
 *  `format-date` reads, and as a branch of an `if`, `coalesce`, `switch` or
 *  `cond` that stands in one of those places; in a search's CSQL only where
 *  the device works the value out (`printsOnDevice`), since CSQL keeps a
 *  `datetime()` HQ reads as written. */
function foldedCoercions(
	node: Expression,
	path: CheckPath,
	root: Expression,
	context: ExpressionContext,
	folds: boolean,
): Expression {
	if (
		folds &&
		node.kind === "datetime-coerce" &&
		printsOnDevice(context, { path, tree: root })
	) {
		const term = termOf(node.value);
		const literal =
			term?.kind === "literal" && typeof term.value === "string"
				? { value: term.value, type: term.data_type }
				: undefined;
		const shape =
			literal === undefined
				? undefined
				: (literal.type ?? literalShape(literal.value)?.type);
		const text =
			literal !== undefined && (shape === "date" || shape === "datetime")
				? literalInstantText(literal.value)
				: undefined;
		if (text !== undefined) {
			// A slot's whole value is read as an untyped literal unless the
			// slot expects a date or a date and time (`folds.ts::slotLiteral`).
			const expectation = context.profile.expectation;
			const typed =
				path.length > 0 ||
				(expectation.kind === "value" &&
					(expectation.type === "date" || expectation.type === "datetime"));
			return {
				kind: "term",
				term: typed
					? { kind: "literal", value: text, data_type: "datetime" }
					: { kind: "literal", value: text },
			};
		}
	}
	let childFolds: (childPath: CheckPath) => boolean;
	if (isComparison(node)) {
		const at =
			path.length === 0
				? context
				: expressionContextAtPath(root, context, path);
		const operands = comparisonOperands(node, at);
		const day =
			comparisonPlan(node.kind, operands.left, operands.right) === "day";
		childFolds = () => !day;
	} else if (node.kind === "in") {
		// A membership prints its subject as each of its equalities does, so
		// the subject folds where the equality with its first value does.
		const at =
			path.length === 0
				? context
				: expressionContextAtPath(root, context, path);
		const operands = comparisonOperands(
			{
				kind: "eq",
				left: node.left,
				right: { kind: "term", term: node.values[0] },
			},
			at,
		);
		const day = comparisonPlan("eq", operands.left, operands.right) === "day";
		childFolds = (childPath) => !day && childPath.at(-1) === "left";
	} else if (node.kind === "format-date") {
		// `format-date` reads its date as a date and time, which the coercion
		// of a literal and the literal of the text it prints both print as.
		childFolds = (childPath) => childPath.at(-1) === "date";
	} else if (node.kind === "date-coerce") {
		// `date()` reads a date and time in the device's own date, which the
		// coercion of a literal and the literal of the text it prints both
		// print through alike (`fromExpression.ts::deviceTemporalValue`).
		childFolds = (childPath) => childPath.at(-1) === "value";
	} else if (
		node.kind === "if" ||
		node.kind === "coalesce" ||
		node.kind === "switch" ||
		isCall(node, "cond")
	) {
		const outputs: CheckPath[] = [];
		visitAssignmentOutputs(node, path, (_, outputPath) => {
			outputs.push(outputPath);
		});
		// A child folds where it is a branch, or holds one, of the node.
		childFolds = (childPath) =>
			folds &&
			outputs.some(
				(output) =>
					output.length >= childPath.length &&
					childPath.every((segment, index) => output[index] === segment),
			);
	} else childFolds = () => false;
	return mapExpressionChildren(
		node,
		(child) =>
			child.kind === "expression"
				? foldedCoercions(
						child.value,
						child.path,
						root,
						context,
						childFolds(child.path),
					)
				: child.value,
		path,
	);
}

/** The branches of an `if`, `coalesce`, `switch` or `cond`, each with its
 *  path and a way to put another in its place; undefined for any other
 *  node. */
export function valueBranches(
	node: Expression,
	path: CheckPath,
):
	| {
			readonly branches: readonly {
				readonly value: Expression;
				readonly path: CheckPath;
			}[];
			readonly rebuild: (branches: readonly Expression[]) => Expression;
	  }
	| undefined {
	if (node.kind === "if")
		return {
			branches: [
				{ value: node.then, path: [...path, "if", "then"] },
				{ value: node.else, path: [...path, "if", "else"] },
			],
			rebuild: ([then, otherwise]) => ({
				...node,
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: then ?? node.then,
				else: otherwise ?? node.else,
			}),
		};
	if (node.kind === "coalesce")
		return {
			branches: node.values.map((value, index) => ({
				value,
				path: [...path, "values", index],
			})),
			rebuild: (values) => ({
				...node,
				values: values as typeof node.values,
			}),
		};
	if (node.kind === "switch")
		return {
			branches: [
				...node.cases.map((entry, index) => ({
					value: entry.then,
					path: [...path, "switch", "cases", index, "then"],
				})),
				{ value: node.fallback, path: [...path, "switch", "fallback"] },
			],
			rebuild: (values) => ({
				...node,
				cases: node.cases.map((entry, index) => {
					const then = values[index] ?? entry.then;
					return then === entry.then ? entry : { ...entry, then };
				}) as unknown as typeof node.cases,
				fallback: values[node.cases.length] ?? node.fallback,
			}),
		};
	if (isCall(node, "cond") && node.args.length % 2 === 1) {
		const indices = node.args.flatMap((_, index) =>
			index % 2 === 1 || index === node.args.length - 1 ? [index] : [],
		);
		return {
			branches: indices.map((index) => ({
				value: node.args[index] as Expression,
				path: [...path, "call", "args", index],
			})),
			rebuild: (values) => ({
				...node,
				args: node.args.map((arg, index) => {
					const at = indices.indexOf(index);
					return at === -1 ? arg : (values[at] ?? arg);
				}),
			}),
		};
	}
	return undefined;
}

/** A record value that prints as a literal text spelled as a date or a date
 *  and time, with that text and the type its spelling names: an untyped
 *  literal, one typed as its spelling, or a `datetime-coerce` of a date or a
 *  date-and-time literal, which prints as the literal's own instant text
 *  (`instant.ts::datetimeCoerceValue`, `literalInstantText`). */
function dateShapedLiteral(
	node: Expression,
): { readonly value: string; readonly type: "date" | "datetime" } | undefined {
	if (node.kind === "datetime-coerce") {
		const coerced = termOf(node.value);
		if (coerced?.kind !== "literal" || typeof coerced.value !== "string")
			return undefined;
		const shape = coerced.data_type ?? literalShape(coerced.value)?.type;
		const text =
			shape === "date" || shape === "datetime"
				? literalInstantText(coerced.value)
				: undefined;
		return text === undefined ? undefined : { value: text, type: "datetime" };
	}
	const literal = termOf(node);
	if (literal?.kind !== "literal" || typeof literal.value !== "string")
		return undefined;
	const shape = literalShape(literal.value)?.type;
	if (shape !== "date" && shape !== "datetime") return undefined;
	return literal.data_type === undefined || literal.data_type === shape
		? { value: literal.value, type: shape }
		: undefined;
}

/** The types of a date or a date and time `node` gives where a reading of its
 *  print reads it beside a literal: none for a literal spelled as one, the
 *  types its branches give for a branch node, and its own type otherwise. */
export function readTypesGiven(
	node: Expression,
	path: CheckPath,
	root: Expression,
	context: ExpressionContext,
): ReadonlySet<"date" | "datetime" | "time"> {
	if (dateShapedLiteral(node) !== undefined) return new Set();
	const branching = valueBranches(node, path);
	if (branching !== undefined)
		return new Set(
			branching.branches.flatMap((branch) => [
				...readTypesGiven(branch.value, branch.path, root, context),
			]),
		);
	let type: string | undefined;
	try {
		const at =
			path.length === 0
				? context
				: expressionContextAtPath(root, context, path);
		type = scalarDataType(typeOf(node, at)?.data);
	} catch (error) {
		rethrowWorkStop(error);
		return new Set();
	}
	return type === "date" || type === "datetime" || type === "time"
		? new Set([type])
		: new Set();
}

/** `node`, a record value at `path` of `root`, with each date or
 *  date-and-time literal it gives typed only where `typed`, or a branch
 *  beside it or beside a branch node around it, gives its type, as a reading
 *  of its print reads it (`folds.ts::typedBranchLiterals`). */
function untypedValueLiterals(
	node: Expression,
	path: CheckPath,
	root: Expression,
	context: ExpressionContext,
	typed: ReadonlySet<string>,
): Expression {
	const literal = dateShapedLiteral(node);
	if (literal !== undefined) {
		const read: Expression = {
			kind: "term",
			term: typed.has(literal.type)
				? { kind: "literal", value: literal.value, data_type: literal.type }
				: { kind: "literal", value: literal.value },
		};
		return sameJson(read, node) ? node : read;
	}
	const branching = valueBranches(node, path);
	if (branching === undefined) return node;
	const inside = new Set(typed);
	for (const type of readTypesGiven(node, path, root, context))
		inside.add(type);
	const branches = branching.branches.map((branch) =>
		untypedValueLiterals(branch.value, branch.path, root, context, inside),
	);
	return branches.every(
		(branch, index) => branch === branching.branches[index]?.value,
	)
		? node
		: branching.rebuild(branches);
}

/** Whether `node` gives a typed date-and-time literal, as itself or through
 *  the branches of an `if`, `coalesce`, `switch` or `cond`. */
function givesMoment(node: Expression, path: CheckPath): boolean {
	const literal = termOf(node);
	if (literal?.kind === "literal") return literal.data_type === "datetime";
	return (
		valueBranches(node, path)?.branches.some((branch) =>
			givesMoment(branch.value, branch.path),
		) === true
	);
}

/** `node`, the value of a `date()`, with each literal spelled as a date it
 *  gives (as itself or through the branches of an `if`, `coalesce`, `switch`
 *  or `cond`) typed only where a branch beside it gives a date, as a reading
 *  types it (`folds.ts`, `typed-branch-literal`); a date and time literal
 *  stays as it is, since `date()` reads a typed one in the device's own date
 *  and prints the text of an untyped one bare. */
function dayLiteralsAsRead(
	node: Expression,
	path: CheckPath,
	root: Expression,
	context: ExpressionContext,
	given: ReadonlySet<string>,
	moment: boolean,
): Expression {
	const literal = termOf(node);
	// Where a branch gives a typed date and time, `date()` reads the whole
	// value in the device's own date, and a reading types every literal
	// spelled as a date and time it gives (`folds.ts`, `device-instant-text`).
	if (
		moment &&
		literal?.kind === "literal" &&
		literal.data_type === undefined &&
		typeof literal.value === "string" &&
		literalShape(literal.value)?.type === "datetime"
	)
		return { kind: "term", term: { ...literal, data_type: "datetime" } };
	if (
		literal?.kind === "literal" &&
		typeof literal.value === "string" &&
		literalShape(literal.value)?.type === "date" &&
		(literal.data_type === undefined || literal.data_type === "date")
	) {
		const { data_type: _type, ...rest } = literal;
		const read: Expression = {
			kind: "term",
			term: given.has("date") ? { ...rest, data_type: "date" } : rest,
		};
		return sameJson(read, node) ? node : read;
	}
	const branching = valueBranches(node, path);
	if (branching === undefined) return node;
	const inside = new Set(given);
	for (const type of readTypesGiven(node, path, root, context))
		inside.add(type);
	const branches = branching.branches.map((branch) =>
		dayLiteralsAsRead(branch.value, branch.path, root, context, inside, moment),
	);
	return branches.every(
		(branch, index) => branch === branching.branches[index]?.value,
	)
		? node
		: branching.rebuild(branches);
}

/** Whether `node` is a branch of `parent`, an `if` or a `coalesce`, beside a
 *  branch of a known type text does not agree with. */
function besideUntextualBranch(
	parent: Expression,
	node: Expression,
	context: ExpressionContext,
): boolean {
	const branches =
		parent.kind === "if"
			? [parent.then, parent.else]
			: parent.kind === "coalesce"
				? parent.values
				: [];
	if (!branches.includes(node)) return false;
	return branches.some((branch) => {
		if (branch === node) return false;
		const literal = termOf(branch);
		if (literal?.kind === "literal" && literal.value === null) return false;
		let type: string | undefined;
		try {
			type = scalarDataType(typeOf(branch, context)?.data);
		} catch (error) {
			rethrowWorkStop(error);
			return false;
		}
		return (
			type !== undefined &&
			type !== "_any" &&
			type !== "text" &&
			type !== "single_select" &&
			type !== "multi_select"
		);
	});
}

/** Whether `parent` is an equality whose side other than the one at `path`
 *  gives a known type no text agrees with. */
function comparedWithUntextual(
	parent: Expression,
	path: CheckPath,
	context: ExpressionContext,
): boolean {
	if (parent.kind !== "eq" && parent.kind !== "neq") return false;
	const side = path.at(-1);
	const other =
		side === "left" ? parent.right : side === "right" ? parent.left : undefined;
	if (other === undefined) return false;
	try {
		return untextualType(scalarDataType(typeOf(other, context)?.data));
	} catch (error) {
		rethrowWorkStop(error);
		return false;
	}
}

/** The nodes of `tree` above the one at `path`, the root first, each with the
 *  role of its edge toward that node; undefined where no node stands at
 *  `path`. */
function ancestryOf(
	tree: Expression,
	path: CheckPath,
):
	| readonly { readonly node: Expression; readonly role: ExpressionChildRole }[]
	| undefined {
	const prefix = (child: CheckPath) =>
		child.length <= path.length &&
		child.every((segment, index) => path[index] === segment);
	const above: { node: Expression; role: ExpressionChildRole }[] = [];
	let at: Expression = tree;
	let atPath: CheckPath = [];
	while (atPath.length < path.length) {
		const next = expressionChildren(at, atPath).find(
			(child) => child.kind === "expression" && prefix(child.path),
		);
		if (next === undefined || next.kind !== "expression") return undefined;
		above.push({ node: at, role: next.role });
		at = next.value;
		atPath = next.path;
	}
	return above;
}

/** The node of `tree` whose child stands at `path`; undefined at the root. */
function parentOf(tree: Expression, path: CheckPath): Expression | undefined {
	return ancestryOf(tree, path)?.at(-1)?.node;
}

/** Whether the node at `path` is a value an enclosing `datetime-coerce`
 *  reads through value branches alone: a device prints that coercion leaf by
 *  leaf (`instantOperand.ts::instantOperand`, which passes through branches
 *  and coercions), so the node is never printed as a value of its own. */
function readByEnclosingCoercion(tree: Expression, path: CheckPath): boolean {
	const above = ancestryOf(tree, path) ?? [];
	for (let index = above.length - 1; index >= 0; index--) {
		const step = above[index];
		if (step === undefined) return false;
		const { node, role } = step;
		if (node.kind === "datetime-coerce") return true;
		const branch =
			(node.kind === "if" &&
				role.kind === "operand" &&
				(role.slot === "then" || role.slot === "else")) ||
			(node.kind === "coalesce" && role.kind === "item") ||
			(node.kind === "switch" &&
				((role.kind === "switch-case" && role.slot === "then") ||
					(role.kind === "operand" && role.slot === "fallback")));
		if (!branch) return false;
	}
	return false;
}

/** Whether the node at `path` stands inside a `when-input-present`'s clause,
 *  which a device's print of a list filter leaves out
 *  (`walk.ts::substituteUnansweredSearchInputs`), so only the search's CSQL
 *  prints it. */
function insideInputPresence(tree: Expression, path: CheckPath): boolean {
	return (ancestryOf(tree, path) ?? []).some(
		({ node, role }) =>
			node.kind === "when-input-present" &&
			role.kind === "operand" &&
			role.slot === "clause",
	);
}

/** Whether the node at `at` prints as a device prints it: anywhere outside a
 *  search's CSQL, and in it where the device works the value out. */
function printsOnDevice(
	context: ExpressionContext,
	at: { readonly path: CheckPath; readonly tree: Expression },
): boolean {
	return (
		!printsCsql(context) ||
		csqlPositionAt(positionsOf(at.tree), at.path) === "runtime"
	);
}

/** The CSQL positions of a slot's tree, each worked out once. */
const positionMemo = new WeakMap<Expression, CsqlPositionMap>();
function positionsOf(tree: Expression): CsqlPositionMap {
	let positions = positionMemo.get(tree);
	if (positions === undefined) {
		positions = csqlPositions(tree);
		positionMemo.set(tree, positions);
	}
	return positions;
}

/** The untyped literal of `node`, a literal typed as the date, the date
 *  and time or the time its own text spells; undefined for anything else. */
function untypedShaped(node: Expression): Literal | undefined {
	const literal = termOf(node);
	if (
		literal?.kind !== "literal" ||
		literal.data_type === undefined ||
		typeof literal.value !== "string" ||
		literalShape(literal.value)?.type !== literal.data_type
	)
		return undefined;
	const { data_type: _type, ...rest } = literal;
	return rest;
}

/** Whether `node` gives a value through branches: an `if`, a `coalesce` or
 *  a `switch`. */
function isBranchNode(node: Expression): boolean {
	return (
		node.kind === "if" || node.kind === "coalesce" || node.kind === "switch"
	);
}

/** `node` with every literal it gives untyped, where every value it can end
 *  with, through each branch, is a literal (a typed one spelled as its type);
 *  undefined otherwise. */
function untypedBranches(node: Expression): Expression | undefined {
	if (node.kind === "term") {
		if (node.term.kind !== "literal") return undefined;
		if (node.term.data_type === undefined) return node;
		const untyped = untypedShaped(node);
		return untyped === undefined ? undefined : { kind: "term", term: untyped };
	}
	if (node.kind === "if") {
		const then = untypedBranches(node.then);
		const otherwise = untypedBranches(node.else);
		return then === undefined || otherwise === undefined
			? undefined
			: { ...node, then, else: otherwise };
	}
	if (node.kind === "coalesce") {
		const values = node.values.map(untypedBranches);
		return values.every((value) => value !== undefined)
			? { ...node, values: values as typeof node.values }
			: undefined;
	}
	if (node.kind === "switch") {
		const fallback = untypedBranches(node.fallback);
		const cases = node.cases.map((entry) => {
			const then = untypedBranches(entry.then);
			return then === undefined ? undefined : { ...entry, then };
		});
		return fallback === undefined ||
			!cases.every((entry) => entry !== undefined)
			? undefined
			: { ...node, cases: cases as typeof node.cases, fallback };
	}
	return undefined;
}

/** Whether a range's two comparisons, joined, print as the range does where
 *  `at` stands: everywhere but a row of a search's condition (the slot's
 *  whole tree or a clause of its top-level `and`), where each clause of a
 *  top-level `and` is a row of its own
 *  (`suite/case-search/xpathQuery.ts::composeXPathQueryClauses`) and the
 *  range is one. */
function joinPrintsAsRange(
	context: ExpressionContext,
	at: { readonly path: CheckPath; readonly tree: Expression },
): boolean {
	if (!printsCsql(context)) return true;
	if (at.path.length === 0) return false;
	return !(
		at.path.length === 2 &&
		at.path[0] === "and" &&
		at.tree.kind === "and"
	);
}

/** `node`, a range, with each bound rewritten as `rewrite` rewrites its own
 *  comparison with the range's operand (a device prints each bound so,
 *  `fromExpression.ts`, `between`): a range where the rewrites keep one
 *  operand, and the two comparisons joined where they do not and the join
 *  prints as the range (`joinPrintsAsRange`); undefined where nothing
 *  changes or the join would not print so. */
function rangeAsComparisons(
	node: Extract<Expression, { kind: "between" }>,
	context: ExpressionContext,
	at: { readonly path: CheckPath; readonly tree: Expression },
	rewrite: (comparison: Comparison) => Expression | undefined,
): Expression | undefined {
	const side = (
		bound: Expression | undefined,
		kind: Comparison["kind"],
	): Comparison | undefined => {
		if (bound === undefined) return undefined;
		const comparison: Comparison = { kind, left: node.left, right: bound };
		const next = rewrite(comparison) ?? comparison;
		return isComparison(next) && next.kind === kind ? next : undefined;
	};
	const lower = side(node.lower, node.lowerInclusive ? "gte" : "gt");
	const upper = side(node.upper, node.upperInclusive ? "lte" : "lt");
	if (
		(node.lower !== undefined && lower === undefined) ||
		(node.upper !== undefined && upper === undefined)
	)
		return undefined;
	// Bounds whose comparisons no longer share an operand read back as those
	// two comparisons, joined.
	if (
		lower !== undefined &&
		upper !== undefined &&
		!sameJson(lower.left, upper.left)
	)
		return joinPrintsAsRange(context, at)
			? { kind: "and", clauses: [lower, upper] }
			: undefined;
	const left = (lower ?? upper)?.left ?? node.left;
	const next: Expression = {
		...node,
		left,
		...(lower === undefined ? {} : { lower: lower.right }),
		...(upper === undefined ? {} : { upper: upper.right }),
	};
	return sameJson(next, node) ? undefined : next;
}

/** `node`, a comparison a device lowers, with each side the tree it reads
 *  back as (`instantOperand.ts::loweredComparisonMembers`; `bare` admits two
 *  unparsed sides read as numbers); `node` itself where the device does not
 *  lower it, undefined where a side has no member. */
function loweredSides(
	node: Comparison,
	context: ExpressionContext,
	bare: boolean,
): Comparison | undefined {
	const operands = comparisonOperands(node, context);
	if (comparisonPlan(node.kind, operands.left, operands.right) !== "lowered")
		return node;
	const record = context.ruleSet === "record";
	const members = bare
		? loweredComparisonMembers(operands.left, operands.right, record)
		: (() => {
				const left = instantOperandMember(operands.left, record);
				const right = instantOperandMember(operands.right, record);
				return left === undefined || right === undefined
					? undefined
					: { left, right };
			})();
	return members === undefined
		? undefined
		: { ...node, left: members.left, right: members.right };
}

/** A membership's subject and values, or a switch's subject and case tests,
 *  as a device's equalities of each value with the subject read back
 *  (`loweredSides`): each value an equality lowers as its member, and the
 *  subject as its member where every equality lowers and gives it one; where
 *  some equalities print two numbers and others do not, every equality as a
 *  parsed one. Undefined where nothing is lowered. */
function testedValues(
	subject: Expression,
	values: readonly Term[],
	context: ExpressionContext,
):
	| { readonly subject: Expression; readonly values: readonly Term[] }
	| undefined {
	const read = (bare: boolean) =>
		values.map((value) => {
			const equality: Comparison = {
				kind: "eq",
				left: subject,
				right: { kind: "term", term: value },
			};
			const lowered = loweredSides(equality, context, bare);
			return lowered === equality ? undefined : lowered;
		});
	let sides = read(true);
	const subjects = (all: typeof sides) =>
		all.flatMap((side) => (side === undefined ? [] : [side.left]));
	if (subjects(sides).some((left, _, every) => !sameJson(left, every[0])))
		sides = read(false);
	if (sides.every((side) => side === undefined)) return undefined;
	const lefts = subjects(sides);
	const [first] = lefts;
	const keepsSubject =
		first !== undefined &&
		lefts.length === values.length &&
		lefts.every((left) => sameJson(left, first));
	return {
		subject: keepsSubject ? first : subject,
		values: values.map((value, index) => {
			const right = sides[index]?.right;
			return right?.kind === "term" && right.term.kind === "literal"
				? right.term
				: value;
		}),
	};
}

/** A membership's subject and values, or a switch's subject and case tests,
 *  each equality of which a device prints as written, with every literal
 *  untyped that its position does not require typed
 *  (`untyped-unrequired-literal`): a branch node of literals alone tested
 *  against literals alone untypes them all, and a typed literal subject is
 *  untyped with each value the untyped subject leaves no type. Undefined
 *  where nothing changes or an equality is lowered. */
function untypedTested(
	subject: Expression,
	values: readonly Term[],
	context: ExpressionContext,
):
	| { readonly subject: Expression; readonly values: readonly Term[] }
	| undefined {
	const lowered = values.some((value) => {
		const equality: Comparison = {
			kind: "eq",
			left: subject,
			right: { kind: "term", term: value },
		};
		const operands = comparisonOperands(equality, context);
		return comparisonPlan("eq", operands.left, operands.right) === "lowered";
	});
	const branches = isBranchNode(subject) ? untypedBranches(subject) : undefined;
	if (
		branches !== undefined &&
		values.every((value) => value.kind === "literal")
	) {
		if (lowered) return undefined;
		const untyped = values.map((value) =>
			value.kind === "literal"
				? (untypedShaped({ kind: "term", term: value }) ?? value)
				: value,
		);
		return sameJson(branches, subject) &&
			untyped.every((value, index) => sameJson(value, values[index]))
			? undefined
			: { subject: branches, values: untyped };
	}
	const untyped = untypedShaped(subject);
	if (untyped === undefined || lowered) return undefined;
	const left: Expression = { kind: "term", term: untyped };
	return {
		subject: left,
		values: values.map((value) => {
			if (value.kind !== "literal") return value;
			const bare = untypedShaped({ kind: "term", term: value });
			if (bare === undefined) return value;
			return shapedLiteral(bare, left, context, false).data_type === undefined
				? bare
				: value;
		}),
	};
}

/** Every row, in the order of the table. */
export const PRINT_COLLISIONS: readonly PrintCollision[] = [
	{
		id: "field-spelling",
		rewrite(node, context, at) {
			const read = formRead(node);
			if (read?.spelling === undefined) return undefined;
			if (boundRead(read, at.print)) return withSpelling(read, undefined);
			if (read.spelling !== "absolute") return undefined;
			return relocationSite(read, context, at.print) === undefined
				? withSpelling(read, undefined)
				: undefined;
		},
	},
	{
		id: "default-current",
		rewrite(node, context, at) {
			const read = formRead(node);
			if (read === undefined || read.spelling === "current") return undefined;
			if (read.spelling === "relative") return undefined;
			return relocationSite(read, context, at.print) === "default"
				? withSpelling(read, "current")
				: undefined;
		},
	},
	{
		id: "row-predicate-current",
		rewrite(node, context, at) {
			const read = formRead(node);
			if (read === undefined || read.spelling === "current") return undefined;
			if (read.spelling === "relative") return undefined;
			return relocationSite(read, context, at.print) === "row-predicate"
				? withSpelling(read, "current")
				: undefined;
		},
	},
	{
		id: "literal-type",
		rewrite(node, context) {
			if (context.ruleSet !== "record") return undefined;
			if (isComparison(node)) {
				const ordering = node.kind !== "eq" && node.kind !== "neq";
				const left = termOf(node.left);
				const right = termOf(node.right);
				if (left?.kind === "literal") {
					const typed = shapedLiteral(left, node.right, context, ordering);
					if (typed !== left)
						return { ...node, left: { kind: "term", term: typed } };
				}
				if (right?.kind === "literal") {
					const typed = shapedLiteral(right, node.left, context, ordering);
					if (typed !== right)
						return { ...node, right: { kind: "term", term: typed } };
				}
				return undefined;
			}
			if (node.kind === "in") {
				const values = node.values.map((value) =>
					value.kind === "literal"
						? shapedLiteral(value, node.left, context, false)
						: value,
				);
				return values.some((value, index) => value !== node.values[index])
					? { ...node, values: values as typeof node.values }
					: undefined;
			}
			if (node.kind === "between") {
				const bound = (side: Expression | undefined) => {
					const term = side === undefined ? undefined : termOf(side);
					if (term?.kind !== "literal") return side;
					const typed = shapedLiteral(term, node.left, context, true);
					return typed === term
						? side
						: ({ kind: "term", term: typed } as const);
				};
				const lower = bound(node.lower);
				const upper = bound(node.upper);
				return lower === node.lower && upper === node.upper
					? undefined
					: {
							...node,
							...(lower === undefined ? {} : { lower }),
							...(upper === undefined ? {} : { upper }),
						};
			}
			if (node.kind === "switch") {
				const cases = node.cases.map(
					(entry): SwitchCase =>
						entry.when.kind === "literal"
							? {
									...entry,
									when: shapedLiteral(entry.when, node.on, context, false),
								}
							: entry,
				);
				return cases.some(
					(entry, index) => entry.when !== node.cases[index]?.when,
				)
					? { ...node, cases: cases as typeof node.cases }
					: undefined;
			}
			return undefined;
		},
	},
	{
		// A literal typed as the date, the date and time or the time its text
		// spells, compared where the device's print does not lower it to a
		// moment, prints that text whether it is typed or not; a reading types
		// it only where its position requires the type (`literal-type`,
		// `temporalLiterals.ts::typedWhereRequired`), so elsewhere it returns
		// the untyped literal. A membership's subject is no such position.
		id: "untyped-unrequired-literal",
		rewrite(node, context, at) {
			if (context.ruleSet !== "record" || !printsOnDevice(context, at))
				return undefined;
			if (isComparison(node)) {
				const operands = comparisonOperands(node, context);
				if (
					comparisonPlan(node.kind, operands.left, operands.right) === "lowered"
				)
					return undefined;
				const ordering = node.kind !== "eq" && node.kind !== "neq";
				const side = (value: Expression, other: Expression): Expression => {
					const untyped = untypedShaped(value);
					if (untyped === undefined) return value;
					// Ordered against a literal spelled as a date or a date and
					// time, a reading types it (`temporalLiterals.ts`).
					const otherText = stringLiteral(other);
					const otherShape =
						otherText === undefined ? undefined : literalShape(otherText)?.type;
					if (ordering && (otherShape === "date" || otherShape === "datetime"))
						return value;
					// A literal on the other side gives the type its reading gives.
					const opposite = untypedShaped(other);
					const read = shapedLiteral(
						untyped,
						opposite === undefined ? other : { kind: "term", term: opposite },
						context,
						ordering,
					);
					return read.data_type === undefined
						? { kind: "term", term: untyped }
						: value;
				};
				// An equality of literals and branch nodes of literals alone, a
				// branch node among them, reads every literal untyped.
				if (!ordering) {
					const left = untypedBranches(node.left);
					const right = untypedBranches(node.right);
					if (
						left !== undefined &&
						right !== undefined &&
						(isBranchNode(node.left) || isBranchNode(node.right))
					)
						return sameJson(left, node.left) && sameJson(right, node.right)
							? undefined
							: { ...node, left, right };
				}
				const left = side(node.left, node.right);
				const right = side(node.right, node.left);
				return left === node.left && right === node.right
					? undefined
					: { ...node, left, right };
			}
			if (node.kind === "in") {
				const tested = untypedTested(node.left, node.values, context);
				return tested === undefined
					? undefined
					: {
							...node,
							left: tested.subject,
							values: tested.values as typeof node.values,
						};
			}
			// A switch tests each case against its subject as a membership
			// tests each value (`fromExpression.ts::switchTests`).
			if (node.kind === "switch") {
				const tested = untypedTested(
					node.on,
					node.cases.map((entry) => entry.when),
					context,
				);
				return tested === undefined
					? undefined
					: {
							...node,
							on: tested.subject,
							cases: node.cases.map((entry, index) => ({
								...entry,
								when: tested.values[index] ?? entry.when,
							})) as unknown as typeof node.cases,
						};
			}
			return undefined;
		},
	},
	{
		// A case write of a date and time writes a date-and-time literal as
		// the text CommCare HQ stores for its moment (`xform/caseOps.ts`,
		// through `datetimeCaseValue`), so every spelling of one moment
		// prints alike there; the reader gives the moment's canonical text.
		id: "stored-instant-literal",
		rewrite(node, context, at) {
			const expectation = context.profile.expectation;
			if (
				!at.root ||
				context.slot.slot !== "case_operation_write_value" ||
				expectation.kind !== "assignment" ||
				!expectation.destinations.includes("datetime")
			)
				return undefined;
			const literal = termOf(node);
			if (
				literal?.kind !== "literal" ||
				literal.data_type !== "datetime" ||
				typeof literal.value !== "string"
			)
				return undefined;
			const micros = literalInstantMicros(literal.value);
			return relitText(
				node,
				micros === undefined ? undefined : instantTextOfMicros(micros),
			);
		},
	},
	{
		// A comparison a device lowers to microseconds prints each side leaf
		// by leaf as `instantOperand.ts::instantLeafSpelling` spells it, the
		// one function the emitter prints by and the checker refuses by, and a
		// reading reads each spelling as the one member
		// `instantSpellingMember` gives it (`folds.ts`, `instant-comparison`):
		// a folded literal as the canonical text of its moment, a literal
		// branch as its own text, a typed date and time or text with no
		// coercion, a midnight as its coercion, and two sides neither of which
		// is parsed (two folded literals, a day number) as the numbers they
		// print. This holds through every branch node and coercion of a side,
		// and for every container whose tests a device lowers: a comparison,
		// each bound of a range, each equality of a membership and each case
		// test of a switch. A search's condition prints a comparison that
		// reads the case into CSQL as written, so only what a device works out
		// there is touched.
		id: "instant-operand",
		rewrite(node, context, at) {
			// A comparison that reads no case is worked out on the device
			// whole, in CSQL too.
			if (!printsOnDevice(context, at) && readsSearchRow(node))
				return undefined;
			if (isComparison(node)) {
				const next = loweredSides(node, context, true);
				return next === undefined || sameJson(next, node) ? undefined : next;
			}
			if (node.kind === "between") {
				const range = (bare: boolean) =>
					rangeAsComparisons(node, context, at, (comparison) =>
						loweredSides(comparison, context, bare),
					);
				// Bounds one of which a device compares as two numbers and the
				// other through a parse read back as one range of the literal
				// (`folds.ts::momentPair`), the members of a parsed side.
				const split = range(true);
				return split === undefined || split.kind === "and"
					? range(false)
					: split;
			}
			if (node.kind === "in") {
				const tested = testedValues(node.left, node.values, context);
				if (tested === undefined) return undefined;
				const next = {
					...node,
					left: tested.subject,
					values: tested.values as typeof node.values,
				};
				return sameJson(next, node) ? undefined : next;
			}
			if (node.kind === "switch") {
				const tested = testedValues(
					node.on,
					node.cases.map((entry) => entry.when),
					context,
				);
				if (tested === undefined) return undefined;
				const next = {
					...node,
					on: tested.subject,
					cases: node.cases.map((entry, index) => ({
						...entry,
						when: tested.values[index] ?? entry.when,
					})) as unknown as typeof node.cases,
				};
				return sameJson(next, node) ? undefined : next;
			}
			return undefined;
		},
	},
	{
		// A `datetime-coerce` of a date or a date-and-time literal is folded
		// at emission (`instantOperand.ts`, class `literal-instant`): as a
		// value it prints the literal's own text
		// (`instant.ts::datetimeCoerceValue`, `literalInstantText`), and as a
		// comparison's operand that text's microseconds, which is what the
		// date-and-time literal of that text prints in both places. A device
		// comparison by day prints the coercion as `date()`, and CSQL as
		// `datetime()` outside what the device works out, so neither is
		// touched. The reader returns the literal.
		id: "coerced-instant-literal",
		rewrite(node, context, at) {
			if (!at.root || context.ruleSet !== "record") return undefined;
			const folded = foldedCoercions(node, [], node, context, true);
			return folded === node ? undefined : folded;
		},
	},
	{
		// A date or a date-and-time literal, or a `datetime-coerce` of one, that
		// a record slot's whole value, a part of a `concat`, the value of a
		// `date()`, a `datetime()` or a `double()`, the value a blank test, a
		// pattern or a match tests gives, as itself or through the branches
		// of an `if`, `coalesce`, `switch` or `cond`, prints as its text whether
		// it is typed or not, and none of those positions requires the type. The
		// reader types such text only where its position requires the type
		// (`temporalLiterals.ts::typedWhereRequired`): beside a branch that
		// gives it, or as the whole value of a slot that expects it, which
		// this row leaves as it is; everywhere else it returns the untyped
		// literal. A search's CSQL keeps such a literal as written, but where
		// it stands in what the device works out (a clause that reads no case).
		id: "untyped-value-literal",
		rewrite(node, context, at) {
			if (context.ruleSet !== "record" || !printsOnDevice(context, at))
				return undefined;
			// A typed date and time inside `date()` prints read in the device's
			// own date (`fromExpression.ts::deviceTemporalValue`), which the
			// untyped text does not; a typed date prints as its text.
			if (node.kind === "date-coerce") {
				const value = dayLiteralsAsRead(
					node.value,
					["value"],
					node,
					context,
					new Set(),
					givesMoment(node.value, ["value"]),
				);
				return value === node.value ? undefined : { ...node, value };
			}
			if (node.kind === "datetime-coerce" || node.kind === "double") {
				const value = untypedValueLiterals(
					node.value,
					["value"],
					node,
					context,
					new Set(),
				);
				return value === node.value ? undefined : { ...node, value };
			}
			if (node.kind === "is-blank" || node.kind === "matches-pattern") {
				const left = untypedValueLiterals(
					node.left,
					["left"],
					node,
					context,
					new Set(),
				);
				return left === node.left ? undefined : { ...node, left };
			}
			if (node.kind === "match") {
				const value = untypedValueLiterals(
					node.value,
					["value"],
					node,
					context,
					new Set(),
				);
				return value === node.value ? undefined : { ...node, value };
			}
			if (node.kind === "concat") {
				const parts = node.parts.map((part, index) =>
					untypedValueLiterals(
						part,
						["parts", index],
						node,
						context,
						new Set(),
					),
				);
				const [first, ...rest] = parts;
				return first === undefined ||
					parts.every((part, index) => part === node.parts[index])
					? undefined
					: { kind: "concat", parts: [first, ...rest] };
			}
			const expectation = context.profile.expectation;
			if (
				!at.root ||
				expectation.kind === "assignment" ||
				(expectation.kind === "value" &&
					(expectation.type === "date" || expectation.type === "datetime"))
			)
				return undefined;
			const untyped = untypedValueLiterals(node, [], node, context, new Set());
			return untyped === node ? undefined : untyped;
		},
	},
	{
		id: "consumer-in-branches",
		rewrite(node) {
			if (!isCall(node, "sum", 1)) return undefined;
			const [arg] = node.args;
			if (arg?.kind === "if")
				return {
					kind: "if",
					cond: arg.cond,
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: { kind: "call", fn: "sum", args: [arg.then] },
					else: { kind: "call", fn: "sum", args: [arg.else] },
				};
			if (isCall(arg, "cond") && arg.args.length % 2 === 1)
				return {
					kind: "call",
					fn: "cond",
					args: arg.args.map((value, index) =>
						index % 2 === 1 || index === arg.args.length - 1
							? { kind: "call", fn: "sum", args: [value] }
							: value,
					),
				};
			return undefined;
		},
	},
	{
		// A table lookup's `where` is simplified wherever it prints; a slot
		// whose emission simplifies its whole tree is simplified at its root.
		id: "filter-identities",
		rewrite(node, context, at) {
			if (node.kind === "table-lookup") {
				const where = simplifyForEmission(node.where);
				if (!sameJson(where, node.where)) return { ...node, where };
			}
			if (!at.root || !simplifiedSlot(context)) return undefined;
			const slot = context.slot;
			const simplified =
				slot.entity === "module" && slot.slot === "case_list_filter"
					? (effectiveFilterForEmission(node) ?? { kind: "match-all" })
					: simplifyForEmission(node);
			return sameJson(simplified, node) ? undefined : simplified;
		},
	},
	{
		// `and(and(a, b), c)` prints `a and b and c`: the printer groups only a
		// later operand of the same precedence, so a first clause of the same
		// junction prints as that many clauses of the outer one.
		id: "junction-first-clause",
		rewrite(node) {
			if (node.kind !== "and" && node.kind !== "or") return undefined;
			const [first, ...rest] = node.clauses;
			if (first?.kind !== node.kind) return undefined;
			const [head, ...more] = first.clauses;
			return { kind: node.kind, clauses: [head, ...more, ...rest] };
		},
	},
	{
		// A device joins a junction's clauses as one list, a clause of the same
		// junction's own clauses among them (`wire/builders.ts::logical`), so
		// `or(a, or(b, c))` prints `a or b or c` there.
		id: "device-nested-junction",
		rewrite(node, context, at) {
			if (
				(node.kind !== "and" && node.kind !== "or") ||
				!printsOnDevice(context, at) ||
				!node.clauses.some((clause) => clause.kind === node.kind)
			)
				return undefined;
			const clauses = node.clauses.flatMap((clause): Expression[] =>
				clause.kind === node.kind ? [...clause.clauses] : [clause],
			);
			return { kind: node.kind, clauses: clauses as typeof node.clauses };
		},
	},
	{
		// A device prints `in` as the `or` of its equalities, which joins an
		// `or` around it as that many clauses (`wire/builders.ts::w.or`), so an
		// `in` in an `or` prints its equalities there. CSQL parenthesizes it.
		id: "membership-in-disjunction",
		rewrite(node, context) {
			if (
				context.ruleSet !== "record" ||
				printsCsql(context) ||
				node.kind !== "or" ||
				!node.clauses.some((clause) => clause.kind === "in")
			)
				return undefined;
			const clauses = node.clauses.flatMap((clause): Expression[] =>
				clause.kind === "in"
					? clause.values.map((value) => ({
							kind: "eq",
							left: clause.left,
							right: { kind: "term", term: value },
						}))
					: [clause],
			);
			return { kind: "or", clauses: clauses as typeof node.clauses };
		},
	},
	{
		// A device prints a range with both bounds as the `and` of its two
		// comparisons (`fromExpression.ts`, `between`), which joins an `and`
		// around it as two clauses (`wire/builders.ts::logical`), so a range in
		// an `and` prints its comparisons there.
		id: "device-range-in-conjunction",
		rewrite(node, context, at) {
			if (
				node.kind !== "and" ||
				!printsOnDevice(context, at) ||
				!node.clauses.some(
					(clause) =>
						clause.kind === "between" &&
						clause.lower !== undefined &&
						clause.upper !== undefined,
				)
			)
				return undefined;
			const clauses = node.clauses.flatMap((clause): Expression[] =>
				clause.kind === "between" &&
				clause.lower !== undefined &&
				clause.upper !== undefined
					? [
							{
								kind: clause.lowerInclusive ? "gte" : "gt",
								left: clause.left,
								right: clause.lower,
							},
							{
								kind: clause.upperInclusive ? "lte" : "lt",
								left: clause.left,
								right: clause.upper,
							},
						]
					: [clause],
			);
			return { kind: "and", clauses: clauses as typeof node.clauses };
		},
	},
	{
		// A device prints `in` as the `or` of its equalities, and so CSQL does
		// inside parentheses, which `csql-parenthesized-join` takes; an `or` CSQL
		// prints bare reads back as itself.
		id: "membership",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || printsCsql(context)) return undefined;
			return joinedMembership(node);
		},
	},
	{
		// Two comparisons of one operand, a lower bound then an upper, print
		// as the range does wherever the join prints as the range
		// (`joinPrintsAsRange`); in a search's rows each top-level conjunct is
		// a row and the range one.
		id: "range",
		rewrite(node, context, at) {
			if (context.ruleSet !== "record" || node.kind !== "and") return undefined;
			if (node.clauses.length !== 2 || !joinPrintsAsRange(context, at))
				return undefined;
			const [lower, upper] = node.clauses;
			if (
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
		},
	},
	{
		// A `null` literal prints as the empty text in every target
		// (`fromExpression.ts::wireLiteral`, `csql/emitter.ts::termValue`), a
		// switch's case among them.
		id: "null-literal",
		rewrite(node, context, at) {
			const blank = (literal: Literal): Literal => {
				if (literal.value !== null) return literal;
				const { data_type: _type, ...rest } = literal;
				return { ...rest, value: "" };
			};
			if (node.kind === "in" || node.kind === "multi-select-contains") {
				const values = node.values.map((value) =>
					value.kind === "literal" ? blank(value) : value,
				);
				return values.some((value, index) => value !== node.values[index])
					? ({ ...node, values } as Expression)
					: undefined;
			}
			if (node.kind === "switch") {
				const cases = node.cases.map(
					(entry): SwitchCase =>
						entry.when.kind === "literal"
							? { ...entry, when: blank(entry.when) }
							: entry,
				);
				return cases.some(
					(entry, index) => entry.when !== node.cases[index]?.when,
				)
					? { ...node, cases: cases as typeof node.cases }
					: undefined;
			}
			const term = termOf(node);
			if (term?.kind !== "literal" || term.value !== null) return undefined;
			// A record ordering takes no text, nor does a comparison with a
			// value of a type text does not agree with, nor a branch beside a
			// branch of such a type, so a blank there reads as `null`
			// (`folds.ts::shapedLiteral`, `blank-branch`).
			const parent = parentOf(at.tree, at.path);
			if (
				context.ruleSet === "record" &&
				parent !== undefined &&
				(ORDERING_KINDS.has(parent.kind) ||
					parent.kind === "between" ||
					comparedWithUntextual(parent, at.path, context) ||
					besideUntextualBranch(parent, node, context))
			)
				return undefined;
			return { kind: "term", term: blank(term) };
		},
	},
	{
		// A slot whose print drops boolean identities prints a blank test of a
		// fixed value as the answer it always gives
		// (`simplify.ts::simplifyForEmission`), which reads back as that answer.
		id: "simplified-blank-literal",
		rewrite(node, context) {
			if (!simplifiedSlot(context) || node.kind !== "is-blank")
				return undefined;
			const simplified = simplifyForEmission(node);
			return simplified.kind === "match-all" || simplified.kind === "match-none"
				? simplified
				: undefined;
		},
	},
	{
		// A minus sign before a positive number prints that negative number's
		// text, which the form parser binds as the negative literal
		// (`expressionAst.ts`, `negative`). Before zero or a negative number it
		// stays a negation: no stored number is negative zero, and two minus
		// signs bind as the negation of the negative number. CSQL prints a
		// number as its text and a negation it holds whole as a value the
		// device works out, which reads back as that negation; inside a
		// value the device works out it prints as a device does.
		id: "negated-number-literal",
		rewrite(node, context, at) {
			if (
				node.kind !== "negate" ||
				(printsCsql(context) &&
					isRuntimeSubtreeRoot(positionsOf(at.tree), at.path))
			)
				return undefined;
			const literal = termOf(node.value);
			if (
				literal?.kind !== "literal" ||
				typeof literal.value !== "number" ||
				!(literal.value > 0)
			)
				return undefined;
			return {
				kind: "term",
				term: { ...literal, value: -literal.value },
			};
		},
	},
	{
		// A `format-date` preset prints as the pattern it names in every target
		// (`fromExpression.ts`, `dateFormats.ts::resolveCommCareDatePattern`),
		// which the reading binds as that pattern's text.
		id: "format-date-preset",
		rewrite(node) {
			if (node.kind !== "format-date" || typeof node.pattern !== "string")
				return undefined;
			const pattern = resolveCommCareDatePattern(node.pattern);
			return pattern === node.pattern ? undefined : { ...node, pattern };
		},
	},
	{
		// A range with one bound prints as its one comparison, on a device
		// (`fromExpression.ts`, `between`) and in CSQL alike, which reads back
		// as that comparison.
		id: "one-sided-range",
		rewrite(node) {
			if (node.kind !== "between") return undefined;
			if ((node.lower === undefined) === (node.upper === undefined))
				return undefined;
			return node.lower !== undefined
				? {
						kind: node.lowerInclusive ? "gte" : "gt",
						left: node.left,
						right: node.lower,
					}
				: {
						kind: node.upperInclusive ? "lte" : "lt",
						left: node.left,
						right: node.upper as Expression,
					};
		},
	},
	{
		// A yes or no literal prints as the text `true` or `false` in every
		// target (`fromExpression.ts::wireLiteral`, `csql/emitter.ts`), which
		// reads back as that text.
		id: "boolean-literal",
		rewrite(node, _context, at) {
			const text = (literal: Literal): Literal =>
				typeof literal.value === "boolean"
					? { kind: "literal", value: String(literal.value) }
					: literal;
			if (node.kind === "in") {
				const values = node.values.map((value) =>
					value.kind === "literal" ? text(value) : value,
				);
				return values.some((value, index) => value !== node.values[index])
					? { ...node, values: values as typeof node.values }
					: undefined;
			}
			if (node.kind === "multi-select-contains") {
				const values = node.values.map((value) =>
					value.kind === "literal" ? text(value) : value,
				);
				return values.some((value, index) => value !== node.values[index])
					? { ...node, values: values as typeof node.values }
					: undefined;
			}
			if (node.kind === "switch") {
				const cases = node.cases.map((entry) =>
					entry.when.kind === "literal" && text(entry.when) !== entry.when
						? { ...entry, when: text(entry.when) }
						: entry,
				);
				return cases.some((entry, index) => entry !== node.cases[index])
					? { ...node, cases: cases as typeof node.cases }
					: undefined;
			}
			const literal = termOf(node);
			if (literal?.kind !== "literal" || typeof literal.value !== "boolean")
				return undefined;
			// A `datetime-coerce` reads a yes or no as no text
			// (`instantOperand.ts`, class `not-instant`), which prints
			// otherwise than the text `true`; `coerced-day` takes it first.
			if (parentOf(at.tree, at.path)?.kind === "datetime-coerce")
				return undefined;
			return { kind: "term", term: text(literal) };
		},
	},
	{
		// The absence of a related case prints as the negation of its
		// presence on a device and in CSQL alike (`fromExpression.ts`,
		// `csql/emitter.ts`, `missing`), which reads back as the absence.
		id: "negated-presence",
		rewrite(node, context, at) {
			if (
				context.ruleSet !== "record" ||
				node.kind !== "not" ||
				node.clause.kind !== "exists"
			)
				return undefined;
			// A slot whose print simplifies its tree prints the negation of a
			// negated presence as the presence (`simplify.ts`), which
			// `filter-identities` returns.
			if (simplifiedSlot(context) && parentOf(at.tree, at.path)?.kind === "not")
				return undefined;
			return { ...node.clause, kind: "missing" };
		},
	},
	{
		// On a device a `datetime-coerce` of a `datetime-coerce` prints as the
		// inner one (`instantOperand.ts`, a coercion's own value is coerced
		// once), which reads back as that one.
		id: "coerced-coercion",
		rewrite(node, context, at) {
			if (
				node.kind !== "datetime-coerce" ||
				node.value.kind !== "datetime-coerce" ||
				context.ruleSet !== "record" ||
				!printsOnDevice(context, at)
			)
				return undefined;
			return node.value;
		},
	},
	{
		// On a device a membership of one value prints as its one equality
		// (`fromExpression.ts`, `in`), which reads back as that equality; a
		// list filter its search restates is read in the list's spelling. A
		// search's condition prints it as that equality too
		// (`csql/emitter.ts::membership`), but a date's or a date and time's,
		// which it prints as the range of the value's day or moment; one that
		// reads no case is worked out on the device, as an equality.
		id: "one-value-membership",
		rewrite(node, context, at) {
			if (
				node.kind !== "in" ||
				node.values.length !== 1 ||
				context.ruleSet !== "record"
			)
				return undefined;
			if (
				context.slot.slot === "search_input_predicate" &&
				!printsOnDevice(context, at) &&
				readsSearchRow(node)
			) {
				let type: string | undefined;
				try {
					type = scalarDataType(typeOf(node.left, context)?.data);
				} catch (error) {
					rethrowWorkStop(error);
					return undefined;
				}
				if (type === undefined || type === "date" || type === "datetime")
					return undefined;
			}
			const [only] = node.values;
			return {
				kind: "eq",
				left: node.left,
				right: { kind: "term", term: only },
			};
		},
	},
	{
		// A Search field's condition prints as CSQL, which puts a case
		// property compared on the right onto the left with the comparison
		// mirrored (`csql/representability.ts::normalizeCsqlPredicate`), and
		// the row reads back so. A list filter its search restates prints a
		// clause inside a Search field's presence test in that row alone, so
		// the reader reads it in the row's spelling; every other clause of
		// the filter it reads in the list's own (`search/rows.ts`).
		id: "csql-anchor-left",
		rewrite(node, context, at) {
			if (
				(context.slot.slot !== "search_input_predicate" &&
					!(printsCsql(context) && insideInputPresence(at.tree, at.path))) ||
				!isComparison(node) ||
				isCsqlQueryAnchor(node.left) ||
				!isCsqlQueryAnchor(node.right)
			)
				return undefined;
			return {
				kind: MIRRORED_COMPARISONS[node.kind],
				left: node.right,
				right: node.left,
			};
		},
	},
	{
		// On a device a distance test with a fixed distance in a fixed unit
		// prints its radius as one number of meters
		// (`fromExpression.ts::metersBound`), which reads as that many meters;
		// CSQL keeps the unit as written.
		id: "within-distance-in-meters",
		rewrite(node, context) {
			if (
				node.kind !== "within-distance" ||
				printsCsql(context) ||
				typeof node.distance !== "number" ||
				typeof node.unit !== "string" ||
				node.unit === "meters"
			)
				return undefined;
			return {
				...node,
				distance: distanceToMeters(node.distance, node.unit),
				unit: "meters",
			};
		},
	},
	{
		// On a device a `datetime-coerce` of date-and-time text prints that
		// text as it is (`instant.ts::datetimeCoerceValue`, class `text`),
		// which reads back as the value alone; CSQL keeps `datetime()` as
		// written. A coercion an enclosing one reads through is printed by
		// that one.
		id: "moment-text-coercion",
		rewrite(node, context, at) {
			if (
				node.kind !== "datetime-coerce" ||
				context.ruleSet !== "record" ||
				!printsOnDevice(context, at) ||
				readByEnclosingCoercion(at.tree, at.path)
			)
				return undefined;
			const operand = domainInstantOperand(node, context);
			return operand.kind === "leaf" && operand.class === "text"
				? operand.value
				: undefined;
		},
	},
	{
		// On a device a `datetime-coerce` of a branch node prints the
		// coercion of each branch inside the node
		// (`instant.ts::datetimeCoerceValue`), which reads back as the node of
		// coerced branches; CSQL keeps `datetime()` as written.
		id: "coerced-branches",
		rewrite(node, context, at) {
			if (
				node.kind !== "datetime-coerce" ||
				context.ruleSet !== "record" ||
				!printsOnDevice(context, at)
			)
				return undefined;
			const branching = valueBranches(node.value, []);
			if (branching === undefined) return undefined;
			return branching.rebuild(
				branching.branches.map(
					(branch): Expression => ({
						kind: "datetime-coerce",
						value: branch.value,
					}),
				),
			);
		},
	},
	{
		// On a device a `datetime-coerce` inside another node (an operand, a
		// date a function reads) of a value that names no moment as text (a
		// date the case database holds as a day, a value of no type a device
		// holds as neither text nor a date), and one of a date the case
		// database holds as a day at a slot's root, prints `date()` of the
		// value (`instant.ts::datetimeCoerceValue`, by
		// `instantOperand.ts::coercesToDay`), which is what the date coercion
		// of it prints, and reads back as that. A coercion an enclosing one
		// reads through is printed by that one, as a leaf of its own.
		id: "coerced-day",
		rewrite(node, context, at) {
			if (
				node.kind !== "datetime-coerce" ||
				context.ruleSet !== "record" ||
				!printsOnDevice(context, at) ||
				readByEnclosingCoercion(at.tree, at.path)
			)
				return undefined;
			const parent = parentOf(at.tree, at.path);
			const operand = domainInstantOperand(node, context);
			if (operand.kind !== "leaf") return undefined;
			// At a slot's root a coercion prints a value of another class as
			// its text, and a date the case database holds as a day as `date()`.
			if (parent === undefined && operand.class !== "day-only")
				return undefined;
			if (
				!coercesToDay(operand) ||
				mayHoldInstantText(domainInstantOperand(operand.value, context))
			)
				return undefined;
			return { kind: "date-coerce", value: operand.value };
		},
	},
	{
		// A record slot a menu, a list or a search evaluates reads a standard
		// property of its row's case by the property's name alone, whatever
		// case type the read names, and a reading binds it to the row's type.
		// A case operation's slot prints both as the read of the case the menu
		// chose from the case database (`caseOps.ts::formCasePropertyResolver`),
		// and inside a relation's filter both as the row's own name.
		id: "typed-row-standard-property",
		rewrite(node, context) {
			if (context.ruleSet !== "record") return undefined;
			const term = termOf(node);
			if (
				term?.kind !== "prop" ||
				term.caseType !== undefined ||
				term.via !== undefined ||
				!isStandardCaseListProperty(term.property)
			)
				return undefined;
			const row = activeRowScope(context);
			if (row?.kind !== "case" || row.caseType === undefined) return undefined;
			return { kind: "term", term: { ...term, caseType: row.caseType } };
		},
	},
	{
		// A text compared with a question of fixed choices, tested by
		// `selected`, or a question's own starting value, that names its
		// choices, prints as their values: the form parser binds it as those
		// choices (`expressionAst.ts::choiceFor`).
		id: "choice-literal",
		rewrite(node, context, at) {
			if (isComparison(node)) {
				const left = choiceOf(node.left, node.right, context);
				const right = choiceOf(node.right, node.left, context);
				return left === undefined && right === undefined
					? undefined
					: { ...node, left: left ?? node.left, right: right ?? node.right };
			}
			if (node.kind === "multi-select-contains")
				return choiceSelection(node, context);
			const slot = context.slot;
			if (at.root && slot.entity === "field" && slot.slot === "default_value")
				return choiceOf(
					node,
					{ kind: "term", term: { kind: "field", uuid: slot.uuid } },
					context,
				);
			return undefined;
		},
	},
	{
		// A device tests a selection one value at a time, `selected(p, v)`
		// whatever the quantifier, joined by `or` for any and `and` for all
		// (`fromExpression.ts`), and reads each test back as a selection of
		// any one value. CSQL prints a fixed value `selected(p, 'v')` whatever
		// the quantifier (`csql/emitter.ts::selection`), and a selection of
		// several values in parentheses, which a search row reads back whole.
		id: "selection-per-value",
		rewrite(node, context) {
			if (node.kind !== "multi-select-contains") return undefined;
			if (printsCsql(context)) {
				const [only] = node.values;
				return node.values.length === 1 &&
					only !== undefined &&
					fixedValue(only) &&
					node.quantifier === "all"
					? { ...node, quantifier: "any" }
					: undefined;
			}
			const tests = node.values.map((value): Expression => {
				const test: Selection = {
					kind: "multi-select-contains",
					property: node.property,
					values: [value],
					quantifier: "any",
				};
				return choiceSelection(test, context) ?? test;
			});
			const [first, ...rest] = tests;
			if (first === undefined) return undefined;
			if (rest.length === 0)
				return node.quantifier === "any" ? undefined : first;
			return {
				kind: node.quantifier === "any" ? "or" : "and",
				clauses: [first, ...rest],
			};
		},
	},
	{
		// CSQL parenthesizes a selection of several values and a membership,
		// and so it does an `or` in an `and`: there an `or` of one-value tests
		// of one property prints the bytes of the selection of those values,
		// and an `or` of equalities of one operand the bytes of its membership,
		// which a search row reads back. The slot's own `and` is no such
		// parent: each of its clauses is a row of its own
		// (`suite/case-search/xpathQuery.ts::composeXPathQueryClauses`). A
		// related case's condition is in parentheses of its own, so a
		// selection there prints two pairs and an `or` one.
		id: "csql-parenthesized-join",
		rewrite(node, context, at) {
			if (!printsCsql(context) || node.kind !== "and" || at.root)
				return undefined;
			const clauses = node.clauses.map(joinsInConjunction);
			return clauses.every((clause, index) => clause === node.clauses[index])
				? undefined
				: { ...node, clauses: clauses as typeof node.clauses };
		},
	},
	{
		// A text compared with the case's own type prints as that text, as a
		// case type does; the form parser binds it as the case type
		// (`expressionAst.ts::choiceFor`), and so does a search row's reading.
		id: "case-type-literal",
		rewrite(node) {
			if (!isComparison(node)) return undefined;
			const named = (value: Expression, opposite: Expression) => {
				const literal = termOf(value);
				return termOf(opposite)?.kind === "case-row-type" &&
					literal?.kind === "literal" &&
					literal.data_type === undefined &&
					typeof literal.value === "string"
					? ({
							kind: "term",
							term: { kind: "case-type", caseType: literal.value },
						} as const)
					: undefined;
			};
			const left = named(node.left, node.right);
			const right = named(node.right, node.left);
			return left === undefined && right === undefined
				? undefined
				: { ...node, left: left ?? node.left, right: right ?? node.right };
		},
	},
	{
		// A switch of one case prints as the `if` of its one test, which is
		// the equality of its value and the case's.
		id: "one-case-switch",
		rewrite(node) {
			if (node.kind !== "switch" || node.cases.length !== 1) return undefined;
			const [only] = node.cases;
			return {
				kind: "if",
				cond: {
					kind: "eq",
					left: node.on,
					right: { kind: "term", term: only.when },
				},
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: only.then,
				else: node.fallback,
			};
		},
	},
	{
		id: "switch",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "if") return undefined;
			const folded = switchOfIfChain(node);
			return folded === node ? undefined : folded;
		},
	},
	{
		id: "blank",
		rewrite(node) {
			if (node.kind !== "eq" || numberLiteral(node.right) !== 0)
				return undefined;
			if (!isCall(node.left, "string-length", 1)) return undefined;
			const inner = node.left.args[0];
			if (!isCall(inner, "string", 1)) return undefined;
			const value = inner.args[0];
			return value === undefined
				? undefined
				: { kind: "is-blank", left: value };
		},
	},
	{
		id: "normalize-space",
		rewrite(node) {
			if (!isCall(node, "replace", 3)) return undefined;
			const inner = node.args[0];
			if (
				!isCall(inner, "replace", 3) ||
				stringLiteral(inner.args[1]) !== "[ \\t\\r\\n]+" ||
				stringLiteral(inner.args[2]) !== " " ||
				stringLiteral(node.args[1]) !== "^ | $" ||
				stringLiteral(node.args[2]) !== ""
			)
				return undefined;
			const value = inner.args[0];
			return value === undefined
				? undefined
				: { kind: "call", fn: "normalize-space", args: [value] };
		},
	},
	{
		// `if(R = 0, L div R, (L - L mod R) div R)`: every `L` one operand and
		// every `R` another, or the `if` computes some other value.
		id: "quotient",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "if") return undefined;
			const zero = node.cond;
			const division = node.then;
			if (
				zero.kind !== "eq" ||
				numberLiteral(zero.right) !== 0 ||
				division.kind !== "arith" ||
				division.op !== "div" ||
				!sameJson(zero.left, division.right)
			)
				return undefined;
			const whole = node.else;
			if (
				whole.kind !== "arith" ||
				whole.op !== "div" ||
				!sameJson(whole.right, division.right)
			)
				return undefined;
			const remainder = whole.left;
			if (
				remainder.kind !== "arith" ||
				remainder.op !== "-" ||
				!sameJson(remainder.left, division.left) ||
				remainder.right.kind !== "arith" ||
				remainder.right.op !== "mod" ||
				!sameJson(remainder.right.left, division.left) ||
				!sameJson(remainder.right.right, division.right)
			)
				return undefined;
			return {
				kind: "arith",
				op: "quotient",
				left: division.left,
				right: division.right,
			};
		},
	},
	{
		id: "literal-pieces",
		rewrite(node, context) {
			if (node.kind !== "concat") return undefined;
			const mode = modeOf(context);
			if (mode.target !== "xform" && mode.target !== "hq-json")
				return undefined;
			const pieces: Expression[] = [];
			for (const part of node.parts) {
				const text = stringLiteral(part);
				if (text === undefined) {
					pieces.push(part);
					continue;
				}
				for (const piece of literalTexts(text, mode))
					pieces.push({
						kind: "term",
						term: { kind: "literal", value: piece },
					});
			}
			const parts: Expression[] = [];
			let index = 0;
			while (index < pieces.length) {
				let end = index;
				while (end < pieces.length && stringLiteral(pieces[end]) !== undefined)
					end++;
				if (end === index) {
					parts.push(pieces[index] as Expression);
					index++;
					continue;
				}
				const run = pieces
					.slice(index, end)
					.map((piece) => stringLiteral(piece) as string);
				const joined = run.join("");
				const split = literalTexts(joined, mode);
				if (
					split.length === run.length &&
					split.every((piece, at) => piece === run[at])
				)
					parts.push({
						kind: "term",
						term: { kind: "literal", value: joined },
					});
				else
					for (const piece of run)
						parts.push({
							kind: "term",
							term: { kind: "literal", value: piece },
						});
				index = end;
			}
			const [only, ...more] = parts;
			if (only === undefined) return undefined;
			// A `concat` of one part prints `concat(…)` around it, which the part
			// alone does not, unless the part is a literal that prints alone as
			// the `concat` of its pieces.
			const result: Expression =
				more.length === 0 && printsAsItsOwnConcat(only, mode)
					? only
					: { kind: "concat", parts: [only, ...more] };
			return sameJson(result, node) ? undefined : result;
		},
	},
	{
		// In form logic the own case's property, read as a query of the case
		// the form's menu chose, prints as the form's own read of its case.
		id: "own-case",
		rewrite(node, context) {
			if (context.ruleSet !== "form" || context.form === undefined)
				return undefined;
			const read = readChosenCaseProperty(node);
			const form = context.form;
			if (
				read === undefined ||
				!CASE_LOADING_FORM_TYPES.has(form.type) ||
				read.module !== form.moduleUuid ||
				context.facts.moduleCaseTypes.get(form.moduleUuid) !== read.caseType
			)
				return undefined;
			return {
				kind: "term",
				term: {
					kind: "form-case",
					caseType: read.caseType,
					property: read.property,
				},
			};
		},
	},
	{
		// The session value the form's own case comes in prints as the read of
		// that case's id, `#<own>/case_id`, where the case is read by that
		// value: the case the form's menu chose, in a link's slots, and the one
		// a registration creates.
		id: "own-case-id",
		rewrite(node, context) {
			const form = context.form;
			const term = termOf(node);
			if (form === undefined || term?.kind !== "session-datum")
				return undefined;
			// After the form closes (a link's condition and values) the chosen
			// case's id is its datum; in a registration, before it closes too.
			const link =
				context.slot.slot === "form_link_condition" ||
				context.slot.slot === "form_link_datum_xpath";
			const own =
				(link &&
					term.datum.kind === "selected-case" &&
					term.datum.module === form.moduleUuid) ||
				(term.datum.kind === "new-case" &&
					(link || form.type === "registration"));
			const caseType = context.facts.moduleCaseTypes.get(form.moduleUuid);
			if (!own || caseType === undefined) return undefined;
			return {
				kind: "term",
				term: { kind: "form-case", caseType, property: "case_id" },
			};
		},
	},
	{
		// The worker's own case, queried by its type and the session's user,
		// prints as the worker-record leaf.
		id: "worker-record",
		rewrite(node, context) {
			const slug = usercaseProjection(node);
			if (slug === undefined) return undefined;
			return { kind: "term", term: workerRecordLeaf(slug, context) };
		},
	},
	{
		// A worker field read by name where the app holds a worker property of
		// that slug prints the property's slug, the read of the property, so
		// the name-backed read is the property's read.
		id: "worker-field-by-name",
		rewrite(node, context) {
			const read = termOf(node);
			if (read?.kind !== "session-user") return undefined;
			const leaf = workerLeaf(read.field, context, read.source);
			return leaf.kind === "session-user-property"
				? { kind: "term", term: leaf }
				: undefined;
		},
	},
	{
		// A comparison of two dates and times prints as the arithmetic its
		// lowering builds, so the arithmetic read as calls is that comparison.
		id: "instant",
		rewrite(node, context) {
			if (!isComparison(node)) return undefined;
			const record = context.ruleSet === "record";
			const leftText = instantParseOperand(node.left);
			const rightText = instantParseOperand(node.right);
			if (leftText === undefined && rightText === undefined) return undefined;
			const left = instantSide(node.left, leftText, record);
			const right = instantSide(node.right, rightText, record);
			if (left === undefined || right === undefined) return undefined;
			const bare = { kind: node.kind, left, right } as Comparison;
			const operands = comparisonOperands(bare, context);
			return comparisonPlan(bare.kind, operands.left, operands.right) ===
				"lowered"
				? bare
				: undefined;
		},
	},
	{
		id: "input-presence",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "if") return undefined;
			if (node.else.kind !== "match-all" || node.cond.kind !== "count")
				return undefined;
			const via = node.cond.via;
			const input =
				typeof via === "object" && "kind" in via && via.kind === "term"
					? via.term
					: undefined;
			if (input?.kind !== "input") return undefined;
			return { kind: "when-input-present", input, clause: node.then };
		},
	},
	{
		// A Search field's condition prints a date or a date and time literal
		// inside `date()` or `datetime()` as its text whether it is typed or
		// not, so the literal is typed by its own shape.
		id: "coerced-literal-type",
		rewrite(node, context) {
			if (
				context.slot.slot !== "search_input_predicate" ||
				(node.kind !== "date-coerce" && node.kind !== "datetime-coerce")
			)
				return undefined;
			const term = termOf(node.value);
			if (
				term?.kind !== "literal" ||
				term.data_type !== undefined ||
				typeof term.value !== "string"
			)
				return undefined;
			const shape = literalShape(term.value);
			if (shape?.type !== "date" && shape?.type !== "datetime")
				return undefined;
			return {
				...node,
				value: { kind: "term", term: { ...term, data_type: shape.type } },
			};
		},
	},
	{
		// A device tests an ancestor walk one hop at a time
		// (`rowScope.ts::immediateRelationPresence`): the presence of the
		// first hop's case whose own candidates hold the rest, so a walk of
		// several hops prints as the presence nested hop by hop. A Search
		// field's condition prints as CSQL, which keeps the walk whole.
		id: "relation-hops",
		rewrite(node, context) {
			if (
				context.ruleSet !== "record" ||
				context.slot.slot === "search_input_predicate" ||
				(node.kind !== "exists" && node.kind !== "missing") ||
				node.via.kind !== "ancestor"
			)
				return undefined;
			const [first, second, ...rest] = node.via.via;
			if (first === undefined || second === undefined) return undefined;
			return {
				kind: node.kind,
				via: { kind: "ancestor", via: [first] },
				where: {
					kind: "exists",
					via: { kind: "ancestor", via: [second, ...rest] },
					...(node.where === undefined ? {} : { where: node.where }),
				},
			};
		},
	},
	{
		// A device writes a presence test's candidates, and an ancestor
		// count's, `[<type test> and true()]` with no condition and with
		// `match-all`, which prints `true()`; a Search field's condition prints
		// as CSQL, which tells the two apart. A count of child cases keeps the
		// condition's own print.
		id: "relation-where-match-all",
		rewrite(node, context) {
			if (
				context.ruleSet !== "record" ||
				context.slot.slot === "search_input_predicate" ||
				(node.kind !== "exists" &&
					node.kind !== "missing" &&
					!(
						node.kind === "count" &&
						typeof node.via === "object" &&
						"kind" in node.via &&
						node.via.kind === "ancestor"
					)) ||
				node.where?.kind !== "match-all"
			)
				return undefined;
			const { where: _where, ...rest } = node;
			return rest;
		},
	},
	{
		// Every record target first gives one boolean test one related row
		// (`normalizeRelationEvaluationScopes`): a comparison of a related
		// case's property prints as the presence of a related case whose own
		// property compares, so a record slot's whole tree is that normal form.
		id: "relation-scope",
		rewrite(node, context, at) {
			if (!at.root || context.ruleSet !== "record") return undefined;
			const row = activeRowScope(context);
			const rowType = row?.kind === "case" ? row.caseType : undefined;
			try {
				const normalized = normalizeRelationEvaluationScopes(node, {
					caseTypes: context.facts.caseTypes,
					...(rowType === undefined ? {} : { currentCaseType: rowType }),
				});
				return sameJson(normalized, node) ? undefined : normalized;
			} catch (error) {
				rethrowWorkStop(error);
				// A tree the normalizer refuses is the checker's to refuse.
				return undefined;
			}
		},
	},
	{
		// A relation step or path the catalog resolves prints with the type it
		// reaches, as every target normalizes it first
		// (`normalizeRelationEvaluationScopes.ts::canonicalizeRelationPath`):
		// an untyped `parent` step names its catalog parent, a subcase or any
		// relation its one destination, and an any-relation over `parent`
		// that reaches only one direction is that direction.
		id: "relation-type",
		rewrite(node, context) {
			const row = activeRowScope(context);
			const rowType = row?.kind === "case" ? row.caseType : undefined;
			const typed = (
				via: RelationPath,
				origin: string | undefined,
			): RelationPath | undefined => {
				if (via.kind === "self") return undefined;
				try {
					const canonical = canonicalizeRelationPath(via, {
						caseTypes: context.facts.caseTypes,
						...(origin === undefined ? {} : { currentCaseType: origin }),
					}).via;
					return sameJson(canonical, via) ? undefined : canonical;
				} catch (error) {
					rethrowWorkStop(error);
					// A path the catalog cannot resolve is the checker's to refuse.
					return undefined;
				}
			};
			const term = termOf(node);
			if (term?.kind === "prop" && term.via !== undefined) {
				const via = typed(term.via, rowType ?? term.caseType);
				return via === undefined
					? undefined
					: { kind: "term", term: { ...term, via } };
			}
			if (
				(node.kind === "exists" ||
					node.kind === "missing" ||
					node.kind === "count") &&
				isRelationPath(node.via)
			) {
				const via = typed(node.via, rowType);
				return via === undefined ? undefined : { ...node, via };
			}
			return undefined;
		},
	},
	{
		// In form logic a standard property of a case database row that no
		// type test or id types prints as its own name, whatever case type the
		// read names, and the form parser binds it naming none
		// (`formPathBinding.ts`, which types such a row by the checker's
		// `expressionRowScope` as this row does). A query's projected value is a
		// term of the query, so the query itself carries it.
		id: "untyped-row-standard-property",
		rewrite(node, context) {
			if (context.ruleSet !== "form") return undefined;
			if (node.kind === "project") {
				const value = untypedStandardRead(
					node.value,
					expressionRowScope(node.of, context),
				);
				return value === undefined ? undefined : { ...node, value };
			}
			const term = termOf(node);
			const read =
				term === undefined
					? undefined
					: untypedStandardRead(term, activeRowScope(context));
			return read === undefined ? undefined : { kind: "term", term: read };
		},
	},
];

/** `term` naming no case type, where it is a standard property read of a case
 *  database row `row` that no type test or id types; undefined otherwise. */
function untypedStandardRead(
	term: Term,
	row: ReturnType<typeof activeRowScope>,
): Term | undefined {
	if (
		row?.kind !== "case" ||
		!("root" in row) ||
		row.root !== "casedb" ||
		row.caseType !== undefined ||
		term.kind !== "prop" ||
		term.via !== undefined ||
		term.caseType === undefined ||
		!isStandardCaseListProperty(term.property)
	)
		return undefined;
	const { caseType: _named, ...rest } = term;
	return rest;
}

/** Every collision applied bottom-up until none applies. It never parses; where `guard` is
 *  given, the slot keeps its print: the rows' whole result is taken where it prints as the tree
 *  as given, and otherwise each rewrite is taken only where it keeps that print
 *  (`RewriteGuard`), so a slot no row moves, or whose rows all keep its print, is printed at most
 *  twice. */
export function canonicalExpression(
	expression: Expression,
	context: ExpressionContext,
	print: SlotPrint = {},
	guard?: RewriteGuard,
): Expression {
	// A row that rewrites a node can give children another row rewrites,
	// which one bottom-up pass has already passed, so the passes repeat until
	// one changes nothing.
	const settled = (held?: Parameters<typeof settledBy>[4]): Expression => {
		let current = expression;
		for (let pass = 0; pass < 8; pass++) {
			const next = settledBy(PRINT_COLLISIONS, current, context, print, held);
			if (sameJson(next, current)) return next;
			current = next;
		}
		return current;
	};
	const free = settled();
	if (guard === undefined || sameJson(free, expression)) return free;
	const given = guard.print(expression);
	if (given === undefined || guard.print(free) === given) return free;
	// Some rewrite changes what the slot prints: each is held to the print on its own.
	return settled({
		keeps: (candidate) => guard.print(candidate) === given,
		withheld: (rowId) => guard.withheld(rowId),
	});
}

/** The `relation-type` row alone, bottom-up: each relation path typed as the
 *  catalog resolves it, which every target prints alike, CSQL's search rows
 *  among them (`csql/emitter.ts` writes a hop's type test from the
 *  normalized path). */
export function typedRelations(
	expression: Expression,
	context: ExpressionContext,
): Expression {
	return settledBy(
		PRINT_COLLISIONS.filter((row) => row.id === "relation-type"),
		expression,
		context,
		{},
	);
}

/** `tree` with the expression at `path` replaced by `node`. */
function replacedAt(
	tree: Expression,
	path: CheckPath,
	node: Expression,
): Expression {
	if (path.length === 0) return node;
	const within = (at: CheckPath) =>
		at.length <= path.length && at.every((step, i) => step === path[i]);
	const descend = <T extends Expression | Term>(value: T, at: CheckPath): T =>
		mapExpressionChildren(
			value,
			(child) => {
				if (!within(child.path)) return child.value;
				if (child.path.length === path.length)
					return child.kind === "expression" ? node : child.value;
				return child.kind === "expression" || child.kind === "term"
					? descend(child.value, child.path)
					: child.value;
			},
			at,
		);
	return descend(tree, []);
}

function settledBy(
	rows: readonly PrintCollision[],
	expression: Expression,
	context: ExpressionContext,
	print: SlotPrint,
	guard?: {
		readonly keeps: (candidate: Expression) => boolean;
		readonly withheld: (rowId: string) => void;
	},
): Expression {
	const contextAt = (path: CheckPath): ExpressionContext =>
		path.length === 0
			? context
			: expressionContextAtPath(expression, context, path);
	// The slot's tree with every rewrite taken so far in place, which a guarded rewrite is
	// printed in. A node is visited after every node under it and before any node above it, so
	// the paths of the tree as given still name its nodes.
	let whole = expression;
	const settle = (
		node: Expression,
		at: ExpressionContext,
		path: CheckPath,
	): Expression => {
		const root = path.length === 0;
		let current = node;
		// The rows a print refused at this node as it stands, which are not asked again until
		// another rewrite changes it.
		const refused = new Set<PrintCollision>();
		for (let turn = 0; turn < rows.length * 4; turn++) {
			let next: Expression | undefined;
			let by: PrintCollision | undefined;
			for (const row of rows) {
				if (refused.has(row)) continue;
				next = row.rewrite(current, at, {
					root,
					print,
					path,
					tree: expression,
				});
				if (next !== undefined && next !== current) {
					by = row;
					break;
				}
				next = undefined;
			}
			if (next === undefined || by === undefined) return current;
			if (guard !== undefined) {
				const candidate = replacedAt(whole, path, next);
				if (!guard.keeps(candidate)) {
					refused.add(by);
					guard.withheld(by.id);
					continue;
				}
				whole = candidate;
			}
			refused.clear();
			current = next;
		}
		return current;
	};
	// A term's own expressions (a question read's row filters) are visited
	// through it, so every expression of the tree settles.
	const visitChildren = <T extends Expression | Term>(
		node: T,
		path: CheckPath,
	): T =>
		mapExpressionChildren(
			node,
			(child) =>
				child.kind === "expression"
					? visit(child.value, child.path)
					: child.kind === "term"
						? visitChildren(child.value, child.path)
						: child.value,
			path,
		);
	const visit = (node: Expression, path: CheckPath): Expression =>
		settle(visitChildren(node, path), contextAt(path), path);
	return visit(expression, []);
}
