/**
 * The canonical tree of a Nova document. Two trees can print the same bytes
 * in one slot (an `or` of equalities and an `in`, a read spelled absolute and
 * one with no spelling); the reader gives the folded one, so a read of Nova's
 * own export is compared with this form of the document, defined here
 * independently of the reader. Each row is a rewrite over the typed tree
 * between two trees that print the same bytes, which a test prints in a real
 * slot. Nothing here parses or prints.
 */
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import {
	activeRowScope,
	type ExpressionContext,
} from "@/lib/domain/expression/context";
import { formNodeGraph } from "@/lib/domain/expression/formNodes";
import {
	comparisonOperands,
	comparisonPlan,
	type InstantOperand,
	instantTextOfMicros,
	literalInstantMicros,
	literalInstantText,
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
import { expressionContextAtPath } from "@/lib/domain/expression/typeChecker";
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
import type { Uuid } from "@/lib/domain/uuid";
import { userPropertySlugVerdict } from "../../validator/userPropertySlug";
import type { FormNodeProjection } from "../../xpath/formNodeProjection";
import { crossesSourceRepeatInRowPredicate } from "../../xpath/wire/formReads";
import { literalArguments } from "../../xpath/wire/serialize";
import type { WireMode } from "../../xpath/wire/tree";
import { sameJson } from "../jsonCursor";
import { shapedLiteral as shapedLiteralText } from "./folds";

/** What the emitter's print of the slot binds beside its context: the
 *  questions whose read prints as the path the case operation emitter binds
 *  it to, whatever its spelling, where `xform/caseOps.ts` prints the slot
 *  from a Save to Case block's node (`readExpression.ts::slotPrint`). */
export interface SlotPrint {
	readonly boundFields?: ReadonlySet<Uuid>;
}

/** One row: a tree shape and the canonical tree that prints the same bytes
 *  in this slot. `at.root` says the node is the slot's whole tree, and
 *  `at.print` what the slot's print binds. */
export interface PrintCollision {
	readonly id: string;
	rewrite(
		node: Expression,
		context: ExpressionContext,
		at: { readonly root: boolean; readonly print: SlotPrint },
	): Expression | undefined;
}

const COMPARISON_KINDS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
type Comparison = Extract<
	Expression,
	{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
>;
function isComparison(node: Expression): node is Comparison {
	return COMPARISON_KINDS.has(node.kind);
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

function instantLiteralBranches(
	operand: InstantOperand,
	rewrite: (literal: Expression) => Expression,
	node: Expression,
): Expression {
	switch (operand.kind) {
		case "leaf":
			return stringLiteral(node) === undefined ? node : rewrite(node);
		case "if":
			if (node.kind !== "if") return node;
			return {
				...node,
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: instantLiteralBranches(operand.whenTrue, rewrite, node.then),
				else: instantLiteralBranches(operand.whenFalse, rewrite, node.else),
			};
		case "coalesce": {
			if (node.kind !== "coalesce") return node;
			const values = node.values.map((value, index) => {
				const inner = operand.values[index];
				return inner === undefined
					? value
					: instantLiteralBranches(inner, rewrite, value);
			});
			return { ...node, values: values as typeof node.values };
		}
		case "switch":
			return node;
	}
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
	const matches = [...context.facts.userPropertySlugs].filter(
		([, held]) => held.toLowerCase() === slug.toLowerCase(),
	);
	const [only] = matches;
	const provenance = source === undefined ? {} : { source };
	return matches.length === 1 &&
		only !== undefined &&
		only[1] === slug &&
		userPropertySlugVerdict(slug, NO_SLUGS).ok
		? {
				kind: "session-user-property",
				userPropertyUuid: only[0],
				...provenance,
			}
		: { kind: "session-user", field: slug, ...provenance };
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
		// A device compares a date-and-time literal as the integer it folds
		// to, so every spelling of one moment prints alike there. A search's
		// condition, and a list filter its search restates, print the literal
		// as written into CSQL, which tells the spellings apart.
		id: "instant-literal",
		rewrite(node, context) {
			if (
				!isComparison(node) ||
				context.slot.slot === "search_input_predicate" ||
				(context.slot.slot === "case_list_filter" &&
					context.profile.targets.has("CS"))
			)
				return undefined;
			const operands = comparisonOperands(node, context);
			if (
				comparisonPlan(node.kind, operands.left, operands.right) !== "lowered"
			)
				return undefined;
			const direct = (
				side: Expression,
				operand: InstantOperand,
			): Expression => {
				if (operand.kind === "leaf") {
					const text = stringLiteral(side);
					if (text === undefined) return side;
					const micros = literalInstantMicros(text);
					return relitText(
						side,
						micros === undefined ? undefined : instantTextOfMicros(micros),
					);
				}
				return instantLiteralBranches(
					operand,
					(literal) => {
						const text = stringLiteral(literal);
						return relitText(
							literal,
							text === undefined ? undefined : literalInstantText(text),
						);
					},
					side,
				);
			};
			const left = direct(node.left, operands.left);
			const right = direct(node.right, operands.right);
			return left === node.left && right === node.right
				? undefined
				: { ...node, left, right };
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
		id: "range",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "and") return undefined;
			if (node.clauses.length !== 2) return undefined;
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
		// (`fromExpression.ts::wireLiteral`, `csql/emitter.ts::termValue`).
		id: "null-literal",
		rewrite(node) {
			const term = termOf(node);
			if (term?.kind !== "literal" || term.value !== null) return undefined;
			const { data_type: _type, ...rest } = term;
			return { kind: "term", term: { ...rest, value: "" } };
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
			const [head, ...rest] = cases;
			if (on === undefined || head === undefined || rest.length === 0)
				return undefined;
			return { kind: "switch", on, cases: [head, ...rest], fallback: at };
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
		// A device writes a presence test's candidates `[<type test> and
		// true()]` with no condition and with `match-all`, which prints
		// `true()`; a Search field's condition prints as CSQL, which tells
		// the two apart.
		id: "relation-where-match-all",
		rewrite(node, context) {
			if (
				context.ruleSet !== "record" ||
				context.slot.slot === "search_input_predicate" ||
				(node.kind !== "exists" && node.kind !== "missing") ||
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
			} catch {
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
				} catch {
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
];

/** Every collision applied bottom-up until none applies. It never parses and
 *  never prints. */
export function canonicalExpression(
	expression: Expression,
	context: ExpressionContext,
	print: SlotPrint = {},
): Expression {
	return settledBy(PRINT_COLLISIONS, expression, context, print);
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

function settledBy(
	rows: readonly PrintCollision[],
	expression: Expression,
	context: ExpressionContext,
	print: SlotPrint,
): Expression {
	const contextAt = (path: CheckPath): ExpressionContext =>
		path.length === 0
			? context
			: expressionContextAtPath(expression, context, path);
	const settle = (
		node: Expression,
		at: ExpressionContext,
		root: boolean,
	): Expression => {
		let current = node;
		for (let turn = 0; turn < rows.length * 4; turn++) {
			let next: Expression | undefined;
			for (const row of rows) {
				next = row.rewrite(current, at, { root, print });
				if (next !== undefined && next !== current) break;
				next = undefined;
			}
			if (next === undefined) return current;
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
		settle(visitChildren(node, path), contextAt(path), path.length === 0);
	return visit(expression, []);
}
