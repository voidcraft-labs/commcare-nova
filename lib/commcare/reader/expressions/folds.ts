/**
 * The folds: each proposes a typed arm for a syntax shape an app's text
 * holds, the spelling Nova's emitter writes for that arm (a lowering, a
 * guard, an identity leaf). A proposer reads the node's shape only as far
 * as it needs to build the proposal and proves nothing: the slot's print
 * does, and a proposal whose print differs is withdrawn at its site. A
 * proposer never looks at a name to decide.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	activeRowScope,
	type ExpressionContext,
	pushRowScope,
} from "@/lib/domain/expression/context";
import {
	DISTANCE_UNITS,
	type DistanceUnit,
	METERS_PER_DISTANCE_UNIT,
} from "@/lib/domain/expression/distance";
import {
	GEOPOINT_PROPERTY_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/domain/expression/geopoint";
import {
	type InstantSpelling,
	instantSpellingMember,
	instantTextOfMicros,
	literalInstantMicros,
	literalStoredInstantText,
} from "@/lib/domain/expression/instantOperand";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import type { RuleSet } from "@/lib/domain/expression/profiles";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import {
	type ComparisonKind,
	type DateAddInterval,
	type Expression,
	isRelationPath,
	type Literal,
	type RelationPath,
	type RelationStep,
	type SwitchCase,
	type Term,
} from "@/lib/domain/expression/types";
import { organizationLevelsOf } from "@/lib/domain/organization";
import { isCalendarCaseProperty } from "@/lib/domain/standardCaseProperties";
import type { Uuid } from "@/lib/domain/uuid";
import { caseTypeHopMap } from "../../caseTypeDepths";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { rethrowWorkStop } from "../../workMeter";
import type { FoldApi } from "../../xpath/formParseScope";
import { type FormSyntax, formSyntaxKey } from "../../xpath/formSyntax";
import { formUserProperty } from "../../xpath/referenceBindings";
import { sameJson } from "../jsonCursor";

/** One member per fold of the three tables, in table order. */
export type FoldId =
	| "protected-literal"
	| "typed-literal"
	| "form-read"
	| "own-case-read"
	| "worker-record-read"
	| "operation-id"
	| "acting-user"
	| "unowned"
	| "owner-at-level"
	| "absent-node-guard"
	| "search-text"
	| "empty-rows-guard"
	| "handed-on-rows-guard"
	| "cond"
	| "checklist-guard"
	| "instant-comparison"
	| "device-instant-text"
	| "is-blank"
	| "normalize-space"
	| "quotient"
	| "date-add"
	| "datetime-value"
	| "when-input-present"
	| "in"
	| "between"
	| "within-distance"
	| "typed-branch-literal"
	| "blank-branch"
	| "switch"
	| "relation-property"
	| "relation-presence"
	| "relation-count";

/** What the emitter prints through `current()` at the node a Save to Case
 *  block's expression stands in, each by the key of its parsed syntax
 *  (`formSyntaxKey`): an earlier create's id, to its operation, and an
 *  answer of the block's repeat, to its question. */
export interface OperationPlaceReads {
	readonly operationIds: ReadonlyMap<string, Uuid>;
	readonly fields: ReadonlyMap<string, Uuid>;
}

export interface FoldEnv {
	readonly doc: BlueprintDoc;
	/** The slot's form: each Save to Case create's case id path, to its operation. */
	readonly operationIdPaths: ReadonlyMap<string, Uuid>;
	/** Where the slot is a Save to Case block's expression: the reads the
	 *  emitter prints from the node its text stands in. */
	readonly place?: OperationPlaceReads;
	/** The slot's whole source, where the binding knows it. */
	readonly root?: FormSyntax;
	/** Fold sites withdrawn so far, as `foldId:from:to` of this slot's source. */
	readonly withdrawn: ReadonlySet<string>;
	/** Claims a site of its own for this fold over `span` (a fold that folds
	 *  several runs of one node, each its own site): false where that site is
	 *  withdrawn. A fold that claims none takes the node's own span. */
	use(span: { readonly from: number; readonly to: number }): boolean;
	/** Marks the proposal the node's own reading, as a plain binding is one:
	 *  it claims no fold site, so no difference of the print withdraws it.
	 *  For a node the parser binds to nothing, whose only reading is the
	 *  fold's, and whose print the level search compares. */
	ownReading(): void;
	/** Binds `node` with no fold offered at that node: the plain binding a
	 *  proposal starts from. */
	bindPlain(node: FormSyntax, context: ExpressionContext): Expression;
}

export interface Fold {
	readonly id: FoldId;
	/** The rule sets whose slots are offered the fold. */
	readonly ruleSets: readonly RuleSet[];
	propose(
		node: FormSyntax,
		context: ExpressionContext,
		api: FoldApi,
		env: FoldEnv,
	): Expression | undefined;
}

// ── Syntax shapes ────────────────────────────────────────────────────

type Call = Extract<FormSyntax, { kind: "call" }>;
type Binary = Extract<FormSyntax, { kind: "binary" }>;

/** The node a grouping holds. */
export function core(node: FormSyntax): FormSyntax {
	return node.kind === "group" ? core(node.value) : node;
}

function call(
	node: FormSyntax | undefined,
	name: string,
	arity?: number,
): Call | undefined {
	if (node === undefined) return undefined;
	const at = core(node);
	return at.kind === "call" &&
		at.name === name &&
		(arity === undefined || at.args.length === arity)
		? at
		: undefined;
}

function binary(
	node: FormSyntax | undefined,
	op: string | readonly string[],
): Binary | undefined {
	if (node === undefined) return undefined;
	const at = core(node);
	if (at.kind !== "binary") return undefined;
	return (typeof op === "string" ? at.op === op : op.includes(at.op))
		? at
		: undefined;
}

function stringValue(node: FormSyntax | undefined): string | undefined {
	if (node === undefined) return undefined;
	const at = core(node);
	return at.kind === "string" ? at.value : undefined;
}

function numberValue(node: FormSyntax | undefined): number | undefined {
	if (node === undefined) return undefined;
	const at = core(node);
	if (at.kind === "number") return at.value;
	if (at.kind === "negative") {
		const inner = numberValue(at.value);
		return inner === undefined ? undefined : -inner;
	}
	return undefined;
}

function same(a: FormSyntax | undefined, b: FormSyntax | undefined): boolean {
	return (
		a !== undefined &&
		b !== undefined &&
		formSyntaxKey(core(a)) === formSyntaxKey(core(b))
	);
}

/** One step of a flattened path: its name, whether it is an attribute, and
 *  its predicates. */
export interface PathStep {
	readonly name: string;
	readonly attribute: boolean;
	readonly where: FormSyntax[];
}
export interface FlatPath {
	/** `root` for `/…`, the `instance` or `current` call, or none (relative). */
	readonly root?: FormSyntax;
	readonly steps: PathStep[];
}

/** The name a `..` step takes in a path `flat` reads with `parents`: no XML
 *  name, so no named step is ever taken for it. */
export const PARENT_STEP = "..";

/** A path read as its root and named steps, or undefined where the node is
 *  no path of plain named steps. With `parents`, a `..` step is read as a
 *  step named `PARENT_STEP`. Structural, never textual. */
export function flat(node: FormSyntax, parents = false): FlatPath | undefined {
	const at = core(node);
	if (at.kind === "child") {
		if (at.descendant) return undefined;
		const left =
			at.left === undefined
				? {
						root: {
							kind: "root",
							from: at.from,
							to: at.from + 1,
						} as FormSyntax,
						steps: [],
					}
				: flat(at.left, parents);
		if (left === undefined) return undefined;
		const right = flat(at.step, parents);
		if (right === undefined || right.root !== undefined) return undefined;
		return { ...left, steps: [...left.steps, ...right.steps] };
	}
	if (at.kind === "filter") {
		const base = flat(at.base, parents);
		const last = base?.steps.at(-1);
		if (base === undefined || last === undefined) return undefined;
		return {
			...base,
			steps: [
				...base.steps.slice(0, -1),
				{ ...last, where: [...last.where, at.where] },
			],
		};
	}
	if (at.kind === "call" && (at.name === "instance" || at.name === "current"))
		return { root: at, steps: [] };
	if (at.kind === "root") return { root: at, steps: [] };
	if (parents && at.kind === "parent")
		return { steps: [{ name: PARENT_STEP, attribute: false, where: [] }] };
	if (at.kind === "name" && !at.wildcard)
		return { steps: [{ name: at.name, attribute: false, where: [] }] };
	if (at.kind === "axis" && at.axis === "attribute") {
		const inner = core(at.value);
		if (inner.kind === "name" && !inner.wildcard)
			return { steps: [{ name: inner.name, attribute: true, where: [] }] };
	}
	return undefined;
}

export function instanceId(path: FlatPath | undefined): string | undefined {
	const root = path?.root;
	if (root === undefined || root.kind !== "call" || root.name !== "instance")
		return undefined;
	return stringValue(root.args[0]);
}

function isCurrent(path: FlatPath | undefined): boolean {
	const root = path?.root;
	return (
		root !== undefined &&
		root.kind === "call" &&
		root.name === "current" &&
		root.args.length === 0
	);
}

/** `@case_id = X` as a predicate: X. */
export function caseIdKey(
	where: FormSyntax | undefined,
): FormSyntax | undefined {
	const test = binary(where, "=");
	if (test === undefined) return undefined;
	const left = flat(test.left);
	return left !== undefined &&
		left.root === undefined &&
		left.steps.length === 1 &&
		left.steps[0]?.attribute === true &&
		left.steps[0].name === "case_id" &&
		left.steps[0].where.length === 0
		? test.right
		: undefined;
}

/** `@case_type = 'T'` as a predicate: T. */
export function caseTypeTest(
	where: FormSyntax | undefined,
): string | undefined {
	const test = binary(where, "=");
	if (test === undefined) return undefined;
	const left = flat(test.left);
	return left !== undefined &&
		left.root === undefined &&
		left.steps.length === 1 &&
		left.steps[0]?.attribute === true &&
		left.steps[0].name === "case_type"
		? stringValue(test.right)
		: undefined;
}

/** The case rows of `casedb` a path reads, and what follows the row step. */
export function casedbRow(
	node: FormSyntax,
): { readonly row: PathStep; readonly rest: readonly PathStep[] } | undefined {
	const path = flat(node);
	if (instanceId(path) !== "casedb" || path === undefined) return undefined;
	const [casedb, row, ...rest] = path.steps;
	if (
		casedb?.name !== "casedb" ||
		casedb.where.length > 0 ||
		row?.name !== "case" ||
		row.attribute
	)
		return undefined;
	return { row, rest };
}

/** The case rows a detail reads beside the listed case, `current()/../case`,
 *  the related case HQ copies verbatim into a Search detail
 *  (`relatedCaseProjection.ts`), and what follows the row step. */
export function siblingCaseRow(
	node: FormSyntax,
): { readonly row: PathStep; readonly rest: readonly PathStep[] } | undefined {
	const path = flat(node, true);
	if (path === undefined || !isCurrent(path)) return undefined;
	const [up, row, ...rest] = path.steps;
	if (
		up?.name !== PARENT_STEP ||
		up.where.length > 0 ||
		row?.name !== "case" ||
		row.attribute
	)
		return undefined;
	return { row, rest };
}

/** Whether a node reads a session datum, `instance('commcaresession')/session/data/<id>`. */
function sessionDatumRead(node: FormSyntax): boolean {
	const path = flat(node);
	return (
		instanceId(path) === "commcaresession" &&
		path?.steps.length === 3 &&
		path.steps[0]?.name === "session" &&
		path.steps[1]?.name === "data" &&
		path.steps.every((step) => step.where.length === 0)
	);
}

/** The property a case row's step names: its own name, since Core's
 *  `casedb` answers a `name` step with a blank node, never the case's name. */
export function rowProperty(step: PathStep | undefined): string | undefined {
	if (step === undefined || step.where.length > 0) return undefined;
	return step.name;
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

/** A record literal typed by its own shape, where it stands against a date
 *  or a date and time, or in an ordering against a value of no known type,
 *  and a time of day against a time: a literal Nova stores typed prints the
 *  same bytes as the untyped one, and only the typed one passes the checker.
 *  A blank in an ordering is `null`, which prints as the blank. The search
 *  row reader types a CSQL string by the same rule. */
export function shapedLiteral(
	value: string,
	opposite: Expression | undefined,
	context: ExpressionContext,
	ordering: boolean,
): Literal {
	const other =
		opposite === undefined
			? undefined
			: scalarDataType(typeOf(opposite, context)?.data);
	// A blank ordered against a value, or compared with a value of a known
	// type no text agrees with, is no text, which neither takes: it is the
	// blank `null` prints as.
	if (value === "" && (ordering || untextualType(other)))
		return { kind: "literal", value: null };
	const shape = literalShape(value);
	if (shape === undefined) return { kind: "literal", value };
	const known = other !== undefined && other !== "_any";
	if (shape.type === "time")
		return other === "time"
			? { kind: "literal", value, data_type: "time" }
			: { kind: "literal", value };
	if (
		(known && (other === "date" || other === "datetime")) ||
		(!known && ordering)
	)
		return { kind: "literal", value, data_type: shape.type };
	return { kind: "literal", value };
}

function termOf(expression: Expression): Term | undefined {
	return expression.kind === "term" ? expression.term : undefined;
}

/** The record-only arms: a fold that proposes one in a form slot breaks the
 *  rule that names the rule sets a fold is offered to. */
const RECORD_ONLY: ReadonlySet<Expression["kind"]> = new Set([
	"in",
	"between",
	"switch",
	"when-input-present",
	"date-add",
	"datetime-coerce",
	"id-of",
	"acting-user",
	"unowned",
]);
export function recordOnlyArm(expression: Expression): boolean {
	if (RECORD_ONLY.has(expression.kind)) return true;
	return expression.kind === "arith" && expression.op === "quotient";
}

function slotName(context: ExpressionContext): string {
	return context.slot.slot;
}
function isCaseOperationSlot(context: ExpressionContext): boolean {
	return slotName(context).startsWith("case_operation_");
}
function isOwnerSlot(context: ExpressionContext): boolean {
	return slotName(context) === "case_operation_owner";
}

// ── The literal folds ────────────────────────────────────────────────

/** `substr('\\', 0, 1)`, the printer's spelling of an odd trailing backslash. */
function backslashPiece(node: FormSyntax): boolean {
	const piece = call(node, "substr", 3);
	return (
		piece !== undefined &&
		stringValue(piece.args[0]) === "\\" &&
		numberValue(piece.args[1]) === 0 &&
		numberValue(piece.args[2]) === 1
	);
}
function literalPiece(node: FormSyntax): string | undefined {
	const value = stringValue(node);
	if (value !== undefined) return value;
	return backslashPiece(node) ? "\\" : undefined;
}

const protectedLiteral: Fold = {
	id: "protected-literal",
	ruleSets: ["form", "record"],
	propose(node, context, api, env) {
		const concat = call(node, "concat");
		if (concat === undefined || concat.args.length < 2) return undefined;
		// The runs of two or more literal pieces whose sites are not withdrawn,
		// found before anything is bound: where there is none the call binds
		// plainly, and binding its arguments here too would bind them twice,
		// which doubles at every level of nested `concat`s.
		const runs = new Map<number, { readonly end: number }>();
		let index = 0;
		while (index < concat.args.length) {
			let end = index;
			while (
				end < concat.args.length &&
				literalPiece(concat.args[end] as FormSyntax) !== undefined
			)
				end++;
			const first = concat.args[index];
			const last = concat.args[end - 1];
			if (
				end - index >= 2 &&
				first !== undefined &&
				last !== undefined &&
				env.use({ from: first.from, to: last.to })
			)
				runs.set(index, { end });
			index = end > index ? end : index + 1;
		}
		if (runs.size === 0) return undefined;
		const parts: Expression[] = [];
		index = 0;
		while (index < concat.args.length) {
			const run = runs.get(index);
			if (run !== undefined) {
				const pieces = concat.args.slice(index, run.end);
				const first = pieces[0] as FormSyntax;
				const last = pieces.at(-1) as FormSyntax;
				const value = pieces.map((piece) => literalPiece(piece)).join("");
				parts.push(
					api.term({ kind: "literal", value }, {
						...first,
						to: last.to,
					} as FormSyntax),
				);
				index = run.end;
				continue;
			}
			parts.push(api.bind(concat.args[index] as FormSyntax, context));
			index++;
		}
		const [only, ...more] = parts;
		if (only === undefined) return undefined;
		if (more.length === 0) return only;
		return api.remember({ kind: "concat", parts: [only, ...more] }, node);
	},
};

/** A case write's whole value spelled as the text CommCare HQ stores for a
 *  moment, UTC with six fraction digits and `Z`, as the date-and-time
 *  literal Nova holds for it: its canonical text (`instantTextOfMicros`),
 *  which the emitter writes to a date-and-time property as that stored text
 *  (`xform/caseOps.ts`, through `datetimeCaseValue`) and to any other as
 *  itself, so the print decides. Every writer of the property is bound
 *  against one provisional document, so the write is typed by its own
 *  spelling, never by the property's other writers. */
function storedInstantWrite(
	context: ExpressionContext,
	text: string,
): string | undefined {
	const expectation = context.profile.expectation;
	if (
		expectation.kind !== "assignment" ||
		context.slot.slot !== "case_operation_write_value" ||
		literalStoredInstantText(text) !== text
	)
		return undefined;
	const micros = literalInstantMicros(text);
	return micros === undefined ? undefined : instantTextOfMicros(micros);
}

/** A slot's whole value as one literal, typed by its own shape where the
 *  slot expects a date or a date and time, or a case write holds a moment as
 *  CommCare HQ stores it: the typed literal prints the same bytes, and only
 *  it is the value the slot expects. */
function slotLiteral(
	node: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
	env: FoldEnv,
): Expression | undefined {
	const at = core(node);
	if (at.kind !== "string" || env.root === undefined) return undefined;
	const root = core(env.root);
	if (root.from !== at.from || root.to !== at.to) return undefined;
	const stored = storedInstantWrite(context, at.value);
	if (stored !== undefined)
		return api.term(
			{ kind: "literal", value: stored, data_type: "datetime" },
			node,
		);
	const expectation = context.profile.expectation;
	if (
		expectation.kind !== "value" ||
		(expectation.type !== "date" && expectation.type !== "datetime")
	)
		return undefined;
	const shape = literalShape(at.value);
	if (shape?.type !== "date" && shape?.type !== "datetime") return undefined;
	return api.term(
		{ kind: "literal", value: at.value, data_type: shape.type },
		node,
	);
}

const typedLiteral: Fold = {
	id: "typed-literal",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		const whole = slotLiteral(node, context, api, env);
		if (whole !== undefined) return whole;
		const test = binary(node, [...COMPARISONS.keys()]);
		if (test === undefined) return undefined;
		const leftText = stringValue(test.left);
		const rightText = stringValue(test.right);
		if (leftText === undefined && rightText === undefined)
			return typedBranchesCompared(node, test, context, api);
		const literalSide = leftText !== undefined ? "left" : "right";
		const text = (leftText ?? rightText) as string;
		const ordering = ORDERINGS.has(test.op);
		if (literalShape(text) === undefined && text !== "") return undefined;
		const other = api.bind(
			literalSide === "left" ? test.right : test.left,
			context,
		);
		const literal = shapedLiteral(text, other, context, ordering);
		if (literal.data_type === undefined && literal.value !== null)
			return undefined;
		const kind = COMPARISONS.get(test.op) as ComparisonKind;
		const typed = api.term(
			literal,
			literalSide === "left" ? test.left : test.right,
		);
		return api.remember(
			literalSide === "left"
				? { kind, left: typed, right: other }
				: { kind, left: other, right: typed },
			node,
		);
	},
};

/**
 * The branches of a record value-giving node (an `if`'s two, each `coalesce`
 * value, each `switch` result, each value a `cond` gives), each untyped
 * literal spelled as a date or a date and time typed by its shape where a
 * branch beside it gives that type. Record branches agree on one type, and a
 * typed date or date-and-time literal a branch gives prints the same bytes as
 * the untyped one; only the typed one agrees with its siblings. A branch that
 * is itself an `if`, a `coalesce` or a `switch` gives the type to its own
 * branches too: one bound alone has no typed branch where every branch it
 * gives is such a literal, so it reads as text beside its typed siblings.
 */
function typedBranchLiterals(
	branches: readonly {
		readonly syntax: FormSyntax;
		readonly bound: Expression;
	}[],
	context: ExpressionContext,
	api: FoldApi,
): Expression[] {
	const typed = new Set<string>();
	for (const branch of branches) {
		if (branchLiteralShape(branch) !== undefined) continue;
		let type: string | undefined;
		try {
			type = scalarDataType(typeOf(branch.bound, context)?.data);
		} catch (error) {
			rethrowWorkStop(error);
			continue;
		}
		if (type === "date" || type === "datetime") typed.add(type);
	}
	return branches.map((branch) =>
		retypedBranch(branch.syntax, branch.bound, typed, api),
	);
}

/** A comparison of a branch node that gives a literal spelled as a date or a
 *  date and time (`givesDateShapedLiteral`) with a value of that type, read
 *  with each such literal typed by its shape: the comparison gives the
 *  branches the type a branch beside them would (`typedBranchLiterals`). */
function typedBranchesCompared(
	node: FormSyntax,
	test: Binary,
	context: ExpressionContext,
	api: FoldApi,
): Expression | undefined {
	const leftGives = givesDateShapedLiteral(test.left);
	const rightGives = givesDateShapedLiteral(test.right);
	if (leftGives === rightGives) return undefined;
	const [branchSide, otherSide] = leftGives
		? [test.left, test.right]
		: [test.right, test.left];
	const other = api.bind(otherSide, context);
	let type: string | undefined;
	try {
		type = scalarDataType(typeOf(other, context)?.data);
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
	if (type !== "date" && type !== "datetime") return undefined;
	const bound = api.bind(branchSide, context);
	const typed = retypedBranch(branchSide, bound, new Set([type]), api);
	if (typed === bound) return undefined;
	const kind = COMPARISONS.get(test.op) as ComparisonKind;
	return api.remember(
		leftGives
			? { kind, left: typed, right: other }
			: { kind, left: other, right: typed },
		node,
	);
}

/** `bound`, the reading of `syntax`, with each untyped literal it gives
 *  spelled as a date or a date and time of a type in `typed` typed by its
 *  shape, through the branches of an `if`, a `coalesce` or a `switch` it is. */
function retypedBranch(
	syntax: FormSyntax,
	bound: Expression,
	typed: ReadonlySet<string>,
	api: FoldApi,
): Expression {
	const shape = branchLiteralShape({ syntax, bound });
	if (shape !== undefined)
		return typed.has(shape.type)
			? api.term(
					{ kind: "literal", value: shape.value, data_type: shape.type },
					syntax,
				)
			: bound;
	const inner = (at: FormSyntax | undefined, value: Expression) =>
		at === undefined ? value : retypedBranch(at, value, typed, api);
	if (bound.kind === "if") {
		const branchIf = call(syntax, "if", 3);
		if (branchIf === undefined) return bound;
		const then = inner(branchIf.args[1], bound.then);
		const otherwise = inner(branchIf.args[2], bound.else);
		return then === bound.then && otherwise === bound.else
			? bound
			: api.remember(
					{
						kind: "if",
						cond: bound.cond,
						then,
						else: otherwise,
					},
					syntax,
				);
	}
	if (bound.kind === "coalesce") {
		const values = call(syntax, "coalesce");
		if (values === undefined || values.args.length !== bound.values.length)
			return bound;
		const [first, ...rest] = bound.values.map((value, index) =>
			inner(values.args[index], value),
		);
		return first === undefined ||
			[first, ...rest].every((value, index) => value === bound.values[index])
			? bound
			: api.remember({ kind: "coalesce", values: [first, ...rest] }, syntax);
	}
	if (bound.kind === "switch") {
		const chain = switchChain(syntax);
		if (chain === undefined || chain.tests.length !== bound.cases.length)
			return bound;
		const cases = bound.cases.map((entry, index) => {
			const then = inner(chain.tests[index]?.then, entry.then);
			return then === entry.then ? entry : { ...entry, then };
		});
		const fallback = inner(chain.fallback, bound.fallback);
		const [head, ...rest] = cases;
		return head === undefined ||
			(fallback === bound.fallback &&
				cases.every((entry, index) => entry === bound.cases[index]))
			? bound
			: api.remember({ ...bound, cases: [head, ...rest], fallback }, syntax);
	}
	return bound;
}

/** Whether `syntax` gives a literal spelled as a date or a date and time: it
 *  is one, or one of the branches of the `if`, `coalesce` or record `switch`
 *  it is gives one. */
function givesDateShapedLiteral(syntax: FormSyntax | undefined): boolean {
	if (syntax === undefined) return false;
	const shape = literalShape(stringValue(syntax) ?? "");
	if (shape?.type === "date" || shape?.type === "datetime") return true;
	const branchIf = call(syntax, "if", 3);
	if (branchIf !== undefined)
		return (
			givesDateShapedLiteral(branchIf.args[1]) ||
			givesDateShapedLiteral(branchIf.args[2])
		);
	const values = call(syntax, "coalesce");
	return values?.args.some(givesDateShapedLiteral) === true;
}

/** A branch that is an untyped text literal spelled as a date or a date and
 *  time, with that type. */
function branchLiteralShape(branch: {
	readonly syntax: FormSyntax;
	readonly bound: Expression;
}): { readonly value: string; readonly type: "date" | "datetime" } | undefined {
	const value = stringValue(branch.syntax);
	const term = termOf(branch.bound);
	if (
		value === undefined ||
		term?.kind !== "literal" ||
		term.data_type !== undefined ||
		term.value !== value
	)
		return undefined;
	const shape = literalShape(value);
	return shape?.type === "date" || shape?.type === "datetime"
		? { value, type: shape.type }
		: undefined;
}

/** An `if` or a `coalesce` whose branches give a literal spelled as a date
 *  or a date and time (`givesDateShapedLiteral`), read with that literal
 *  typed where a branch beside it gives its type (`typedBranchLiterals`). */
const typedBranchLiteral: Fold = {
	id: "typed-branch-literal",
	ruleSets: ["record"],
	propose(node, context, api) {
		const branchIf = call(node, "if", 3);
		const values = call(node, "coalesce");
		const positions =
			branchIf !== undefined
				? [1, 2]
				: values !== undefined && values.args.length >= 2
					? values.args.map((_, index) => index)
					: undefined;
		const args = (branchIf ?? values)?.args;
		if (positions === undefined || args === undefined) return undefined;
		if (!positions.some((index) => givesDateShapedLiteral(args[index])))
			return undefined;
		const bound = args.map((arg) => api.bind(arg as FormSyntax, context));
		const branches = typedBranchLiterals(
			positions.map((index) => ({
				syntax: args[index] as FormSyntax,
				bound: bound[index] as Expression,
			})),
			context,
			api,
		);
		if (branches.every((branch, at) => branch === bound[positions[at] ?? 0]))
			return undefined;
		if (branchIf !== undefined)
			return api.remember(
				{
					kind: "if",
					cond: bound[0] as Expression,
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: branches[0] as Expression,
					else: branches[1] as Expression,
				},
				node,
			);
		const [first, ...rest] = branches;
		if (first === undefined) return undefined;
		return api.remember({ kind: "coalesce", values: [first, ...rest] }, node);
	},
};

/** Whether `type` is a known type no text agrees with, as a branch or as
 *  the other side of a comparison. */
export function untextualType(type: string | undefined): boolean {
	return (
		type !== undefined &&
		type !== "_any" &&
		type !== "text" &&
		type !== "single_select" &&
		type !== "multi_select"
	);
}

/**
 * A record value-giving node (an `if`'s two branches, each `coalesce` value)
 * one branch of which is the blank `''` beside a branch of a known type text
 * does not agree with: the blank is `null`, which prints as the blank and is
 * the one blank such branches agree with (the checker's `branch-values`).
 */
const blankBranch: Fold = {
	id: "blank-branch",
	ruleSets: ["record"],
	propose(node, context, api) {
		const branchIf = call(node, "if", 3);
		const values = call(node, "coalesce");
		const args = (branchIf ?? values)?.args;
		if (args === undefined) return undefined;
		const positions = branchIf !== undefined ? [1, 2] : args.map((_, at) => at);
		if (!positions.some((at) => stringValue(args[at]) === "")) return undefined;
		const bound = args.map((arg) => api.bind(arg as FormSyntax, context));
		const typed = positions.some((at) => {
			if (stringValue(args[at]) === "") return false;
			try {
				return untextualType(
					scalarDataType(typeOf(bound[at] as Expression, context)?.data),
				);
			} catch (error) {
				rethrowWorkStop(error);
				return false;
			}
		});
		if (!typed) return undefined;
		const branches = bound.map((one, at) =>
			positions.includes(at) && stringValue(args[at]) === ""
				? api.term({ kind: "literal", value: null }, args[at] as FormSyntax)
				: one,
		);
		if (branchIf !== undefined)
			return api.remember(
				{
					kind: "if",
					cond: branches[0] as Expression,
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: branches[1] as Expression,
					else: branches[2] as Expression,
				},
				node,
			);
		const [first, ...rest] = branches;
		return first === undefined
			? undefined
			: api.remember({ kind: "coalesce", values: [first, ...rest] }, node);
	},
};

// ── Identity leaves ──────────────────────────────────────────────────

const formRead: Fold = {
	id: "form-read",
	ruleSets: ["form", "record"],
	propose(node, context, api, env) {
		// A Save to Case block reads an answer of its own repeat from the node
		// it stands in, through `current()`: the read with no spelling, which
		// prints that binding whether a rewrite is withheld or not.
		const placed = env.place?.fields.get(formSyntaxKey(core(node)));
		if (placed !== undefined)
			return api.term({ kind: "field", uuid: placed }, node);
		const path = flat(node);
		// A record rule holds no read spelled from `current()`, so another
		// `current()` read is held with no spelling too, and the comparison
		// decides whether Nova's print is the source's.
		const climbing = flat(node, true);
		if (
			context.ruleSet === "record" &&
			isCurrent(climbing) &&
			climbing !== undefined &&
			climbing.steps.length > 0
		) {
			const read = termOf(env.bindPlain(node, context));
			if (read?.kind !== "field" || read.spelling !== "current")
				return undefined;
			const { spelling: _current, ...rest } = read;
			return { kind: "term", term: rest };
		}
		if (path?.root?.kind !== "root" || path.steps.length === 0)
			return undefined;
		const bound = env.bindPlain(node, context);
		const read = termOf(bound);
		if (
			read === undefined ||
			(read.kind !== "field" && read.kind !== "repeat-row") ||
			read.spelling !== "absolute"
		)
			return undefined;
		// A Save to Case block prints an answer of its own repeat through its
		// binding, from `current()`. The author's absolute path binds plainly,
		// as `absolute`, the one read that binding prints as written once the
		// relocation is withheld (`formReads.ts::placeBindingWithheld`); the
		// held tree is the re-read of Nova's print, with no spelling.
		if (
			read.kind === "field" &&
			[...(env.place?.fields.values() ?? [])].includes(read.uuid)
		)
			return undefined;
		// Anywhere else, the read with no spelling, at a relocation site too:
		// the emitter prints it `current()/…` there and, with the relocation
		// withheld, as the absolute path the author wrote, while in a form slot
		// a read the author spelled `current()` is stored `current` and keeps
		// that spelling in both prints. The tree a slot held at the second
		// level stores is the re-read of Nova's print, which spells the
		// relocated read `current` (`index.ts::readBack`).
		const { spelling: _absolute, ...rest } = read;
		return { kind: "term", term: rest as Term };
	},
};

/** The indices an own-case walk keyed at `key` follows, from the own case
 *  up: none where the key reads a session datum, one more for each
 *  `…/index/<identifier>` hop around it. A `form-case` read walks the indices
 *  `caseTypeDepths.ts::caseTypeHopMap` gives its type. */
export function ownCaseWalk(
	key: FormSyntax | undefined,
): readonly string[] | undefined {
	if (key === undefined) return undefined;
	if (sessionDatumRead(key)) return [];
	const hop = casedbRow(key);
	if (hop === undefined || hop.row.where.length !== 1) return undefined;
	const [index, identifier, ...more] = hop.rest;
	if (
		more.length > 0 ||
		index?.name !== "index" ||
		index.attribute ||
		index.where.length > 0 ||
		identifier === undefined ||
		identifier.attribute ||
		identifier.where.length > 0
	)
		return undefined;
	const inner = ownCaseWalk(caseIdKey(hop.row.where[0]));
	return inner === undefined ? undefined : [...inner, identifier.name];
}

/** Whether `datum`, a session value, binds to the case a menu other than the
 *  form's own chose. A value the form's entry does not supply binds to no
 *  case, which the slot's own reading refuses. */
function choseElsewhere(
	datum: FormSyntax,
	context: ExpressionContext,
	env: FoldEnv,
): boolean {
	let start: Term | undefined;
	try {
		start = termOf(env.bindPlain(datum, context));
	} catch (error) {
		rethrowWorkStop(error);
		return false;
	}
	return (
		start?.kind === "session-datum" &&
		start.datum.kind === "selected-case" &&
		start.datum.module !== context.form?.moduleUuid
	);
}

/** The session value an own-case walk starts from: the key's innermost
 *  `instance('commcaresession')/session/data/<id>`. */
function walkDatum(key: FormSyntax | undefined): FormSyntax | undefined {
	if (key === undefined) return undefined;
	if (sessionDatumRead(key)) return key;
	const hop = casedbRow(key);
	return hop === undefined || hop.row.where.length !== 1
		? undefined
		: walkDatum(caseIdKey(hop.row.where[0]));
}

const ownCaseRead: Fold = {
	id: "own-case-read",
	ruleSets: ["form", "record"],
	propose(node, context, api, env) {
		// A record slot reads the form's own case where it belongs to a form
		// that loads one: a case operation's, and a form's display condition,
		// whose `#case/` HQ expands over the form's case datum.
		if (context.ruleSet === "record" && context.form === undefined)
			return undefined;
		// The session value the form's own case comes in, `#<own>/case_id`:
		// the case the form's menu chose, or the one a registration creates,
		// in form logic and in a link's slots, which read it after the form.
		const link =
			slotName(context) === "form_link_condition" ||
			slotName(context) === "form_link_datum_xpath";
		if (sessionDatumRead(node) && (context.ruleSet === "form" || link)) {
			const form = context.form;
			const own =
				form === undefined ? undefined : env.doc.modules[form.moduleUuid];
			const read = env.bindPlain(node, context);
			const term = termOf(read);
			if (
				form === undefined ||
				own?.caseType === undefined ||
				term?.kind !== "session-datum" ||
				!(
					(term.datum.kind === "selected-case" &&
						term.datum.module === form.moduleUuid) ||
					term.datum.kind === "new-case"
				)
			)
				return undefined;
			return api.term(
				{ kind: "form-case", caseType: own.caseType, property: "case_id" },
				node,
			);
		}
		const read = casedbRow(node);
		if (read === undefined || read.row.where.length !== 1) return undefined;
		const [step, ...more] = read.rest;
		const property = rowProperty(step);
		if (property === undefined || more.length > 0) return undefined;
		const walk = ownCaseWalk(caseIdKey(read.row.where[0]));
		if (walk === undefined) return undefined;
		// In a record slot of a form (its display condition, its case
		// changes) the walk starts from the form's own case, but where its
		// session value is the case another menu chose, which is that menu's.
		const datum =
			context.ruleSet === "record"
				? walkDatum(caseIdKey(read.row.where[0]))
				: undefined;
		if (datum !== undefined && choseElsewhere(datum, context, env))
			return undefined;
		const moduleUuid = context.form?.moduleUuid;
		const moduleCaseType =
			moduleUuid === undefined
				? undefined
				: env.doc.modules[moduleUuid]?.caseType;
		// In a question's choice filter a `prop` is the candidate case's: the
		// form's own case, or a case above it, is `form-case` there.
		if (context.ruleSet === "record" && context.slot.entity !== "field") {
			if (moduleCaseType === undefined) return undefined;
			const [first, ...others] = walk;
			if (first === undefined)
				return api.term(
					{ kind: "prop", caseType: moduleCaseType, property },
					node,
				);
			if (
				context.slot.slot !== "form_display_condition" &&
				context.slot.slot !== "form_badge"
			)
				return undefined;
			const via = [
				{ identifier: first },
				...others.map((identifier) => ({ identifier })),
			] satisfies [RelationStep, ...RelationStep[]];
			const caseType = destinationType(env.doc, moduleCaseType, via);
			if (caseType === undefined) return undefined;
			return api.term(
				{
					kind: "prop",
					caseType: moduleCaseType,
					property,
					via: { kind: "ancestor", via },
				},
				node,
			);
		}
		const reachable = [
			...caseTypeHopMap(env.doc, moduleCaseType).entries(),
		].find(([, hops]) => sameJson(hops, walk));
		if (reachable === undefined) return undefined;
		return api.term(
			{ kind: "form-case", caseType: reachable[0], property },
			node,
		);
	},
};

const workerRecordRead: Fold = {
	id: "worker-record-read",
	ruleSets: ["form", "record"],
	propose(node, _context, api, env) {
		const read = casedbRow(node);
		if (read === undefined || read.row.where.length !== 2) return undefined;
		const [step, ...more] = read.rest;
		if (step === undefined || step.attribute || step.where.length > 0)
			return undefined;
		if (more.length > 0) return undefined;
		if (caseTypeTest(read.row.where[0]) === undefined) return undefined;
		if (binary(read.row.where[1], "=") === undefined) return undefined;
		return api.term(
			formUserProperty({ doc: env.doc }, step.name, "worker-record"),
			node,
		);
	},
};

/** The text an absolute path of plain steps spells: `/data/…/@case_id`. */
function absoluteText(path: FlatPath): string | undefined {
	if (path.root?.kind !== "root") return undefined;
	const names: string[] = [];
	for (const step of path.steps) {
		if (step.where.length > 0) return undefined;
		names.push(step.attribute ? `@${step.name}` : step.name);
	}
	return `/${names.join("/")}`;
}

/** The text `node` spells where it is an absolute path of plain steps, the
 *  spelling a key of `FoldEnv.operationIdPaths` takes; read structurally. */
export function absolutePathText(node: FormSyntax): string | undefined {
	const path = flat(node);
	return path === undefined ? undefined : absoluteText(path);
}

/** The absolute text a relative or `current()` path of plain steps names from
 *  the node at `context` (the names from the form's root down), the spelling a
 *  key of `FoldEnv.operationIdPaths` takes, or undefined where a step climbs
 *  past the root or carries a predicate; read structurally. */
export function contextPathText(
	node: FormSyntax,
	context: readonly string[],
): string | undefined {
	const path = flat(node, true);
	if (path === undefined || (path.root !== undefined && !isCurrent(path)))
		return undefined;
	const names = [...context];
	for (const step of path.steps) {
		if (step.where.length > 0) return undefined;
		if (!step.attribute && step.name === PARENT_STEP) {
			if (names.length <= 1) return undefined;
			names.pop();
			continue;
		}
		names.push(step.attribute ? `@${step.name}` : step.name);
	}
	return `/${names.join("/")}`;
}

const operationId: Fold = {
	id: "operation-id",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		if (!isCaseOperationSlot(context)) return undefined;
		// Nova reads an earlier create's id from the node the block's
		// expression stands in, through `current()`.
		const placed = env.place?.operationIds.get(formSyntaxKey(core(node)));
		if (placed !== undefined)
			return api.remember({ kind: "id-of", opUuid: placed }, node);
		// A source may name it by its absolute path, which the parser binds to
		// nothing, so this reading is the node's own and no difference of the
		// print withdraws it: the print that leaves the relocation to
		// `current()` out spells the absolute path
		// (`readExpression.ts::relocatedOperationIds`), and where no level
		// prints the source, or the checker refuses the read, the finding is
		// the slot's.
		const text = absolutePathText(node);
		const opUuid =
			text === undefined ? undefined : env.operationIdPaths.get(text);
		if (opUuid === undefined) return undefined;
		env.ownReading();
		return api.remember({ kind: "id-of", opUuid }, node);
	},
};

const actingUser: Fold = {
	id: "acting-user",
	ruleSets: ["record"],
	propose(node, context, api) {
		if (!isOwnerSlot(context)) return undefined;
		const path = flat(node);
		if (
			path === undefined ||
			absoluteText(path) === undefined ||
			path.steps.length !== 3 ||
			path.steps[1]?.name !== "meta" ||
			path.steps[2]?.name !== "userID"
		)
			return undefined;
		return api.remember({ kind: "acting-user" }, node);
	},
};

const unowned: Fold = {
	id: "unowned",
	ruleSets: ["record"],
	propose(node, context, api) {
		if (!isOwnerSlot(context) || stringValue(node) !== "-") return undefined;
		return api.remember({ kind: "unowned" }, node);
	},
};

/** The case type an operation of a form changes, as the document holds it:
 *  its own, or the menu's for the form's own case. */
function operationCaseType(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operationUuid: Uuid,
): string | undefined {
	const operation = doc.forms[formUuid]?.caseOperations?.find(
		(one) => one.uuid === operationUuid,
	);
	if (operation === undefined) return undefined;
	if (operation.action !== "own") return operation.caseType;
	const moduleUuid = Object.keys(doc.formOrder).find((uuid) =>
		doc.formOrder[uuid as Uuid]?.includes(formUuid),
	);
	return moduleUuid === undefined
		? undefined
		: doc.modules[moduleUuid as Uuid]?.caseType;
}

const ownerAtLevel: Fold = {
	id: "owner-at-level",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		if (!isOwnerSlot(context)) return undefined;
		const path = flat(node);
		if (instanceId(path) !== "locations" || path === undefined)
			return undefined;
		const [locations, location, id, ...more] = path.steps;
		if (
			locations?.name !== "locations" ||
			location?.name !== "location" ||
			location.where.length !== 2 ||
			id?.name !== "id" ||
			!id.attribute ||
			more.length > 0
		)
			return undefined;
		const typeTest = binary(location.where[0], "=");
		const typePath = typeTest === undefined ? undefined : flat(typeTest.left);
		const code = stringValue(typeTest?.right);
		if (
			code === undefined ||
			typePath?.steps.length !== 1 ||
			typePath.steps[0]?.name !== "type" ||
			!typePath.steps[0].attribute
		)
			return undefined;
		const levels = Object.values(organizationLevelsOf(env.doc)).filter(
			(level) => level.code === code,
		);
		const level = levels.length === 1 ? levels[0] : undefined;
		if (level === undefined) return undefined;
		const slot = context.slot;
		const operation =
			slot.entity === "form" &&
			"member" in slot &&
			"operationUuid" in slot.member
				? slot.member.operationUuid
				: undefined;
		const ownerCaseType =
			operation === undefined
				? undefined
				: (context.facts.operationCaseTypes.get(operation) ??
					operationCaseType(env.doc, slot.uuid as Uuid, operation));
		if (ownerCaseType === undefined) return undefined;
		return api.term(
			{
				kind: "owner-location-at-level",
				levelUuid: level.uuid,
				ownerCaseType,
			},
			node,
		);
	},
};

// ── Lowerings read back ──────────────────────────────────────────────

/** `count(P) > 0`: P. */
function presentCount(node: FormSyntax | undefined): FormSyntax | undefined {
	const test = binary(node, ">");
	const counted = call(test?.left, "count", 1);
	return counted !== undefined && numberValue(test?.right) === 0
		? counted.args[0]
		: undefined;
}

/** `count(P) = 0`: P. */
function absentCount(node: FormSyntax | undefined): FormSyntax | undefined {
	const test = binary(node, "=");
	const counted = call(test?.left, "count", 1);
	return counted !== undefined && numberValue(test?.right) === 0
		? counted.args[0]
		: undefined;
}

const absentNodeGuard: Fold = {
	id: "absent-node-guard",
	ruleSets: ["form", "record"],
	propose(node, context, api) {
		const guard = call(node, "if", 3);
		const read = presentCount(guard?.args[0]);
		if (guard === undefined || read === undefined) return undefined;
		if (!same(read, guard.args[1]) || stringValue(guard.args[2]) !== "")
			return undefined;
		const path = flat(read);
		if (
			instanceId(path) !== "commcaresession" ||
			path?.steps[0]?.name !== "session" ||
			path.steps[1]?.name !== "context"
		)
			return undefined;
		return api.bind(guard.args[1] as FormSyntax, context);
	},
};

const searchText: Fold = {
	id: "search-text",
	ruleSets: ["form"],
	propose(node, _context, api) {
		const guard = call(node, "if", 3);
		const read = presentCount(guard?.args[0]);
		if (guard === undefined || read === undefined) return undefined;
		const first = core(guard.args[1] as FormSyntax);
		if (
			first.kind !== "filter" ||
			!same(first.base, read) ||
			numberValue(first.where) !== 1 ||
			stringValue(guard.args[2]) !== ""
		)
			return undefined;
		if (!sessionDatumRead(read)) return undefined;
		return api.remember({ kind: "case-list-search-text" }, node);
	},
};

/** `instance(<id>)/<root>/<row>` with no predicate: the rows of a data-built
 *  instance a guard counts. */
function rowsRead(node: FormSyntax | undefined): boolean {
	if (node === undefined) return false;
	const path = flat(node);
	return (
		instanceId(path) !== undefined &&
		path?.steps.length === 2 &&
		path.steps.every((step) => step.where.length === 0 && !step.attribute)
	);
}

const emptyRowsGuard: Fold = {
	id: "empty-rows-guard",
	ruleSets: ["form", "record"],
	propose(node, context, api) {
		const guard = call(node, "if", 3);
		const rows = presentCount(guard?.args[0]);
		if (guard === undefined || !rowsRead(rows)) return undefined;
		const empty = guard.args[2];
		if (stringValue(empty) !== "" && numberValue(empty) !== 0) return undefined;
		return api.bind(guard.args[1] as FormSyntax, context);
	},
};

/** The clauses of an `and` chain, in order. */
export function clauses(node: FormSyntax, op: "and" | "or"): FormSyntax[] {
	const at = core(node);
	if (at.kind === "binary" && at.op === op)
		return [...clauses(at.left, op), ...clauses(at.right, op)];
	return [at];
}

const handedOnRowsGuard: Fold = {
	id: "handed-on-rows-guard",
	ruleSets: ["form"],
	propose(node, context, api) {
		const guard = call(node, "if", 3);
		if (guard === undefined || numberValue(guard.args[1]) !== 0)
			return undefined;
		const [rows, ...blanks] = clauses(guard.args[0] as FormSyntax, "and");
		if (!rowsRead(absentCount(rows)) || blanks.length === 0) return undefined;
		for (const blank of blanks) {
			const test = binary(blank, "=");
			const handed = call(test?.left, "string", 1);
			const inner = call(handed?.args[0], "coalesce", 2);
			if (
				inner === undefined ||
				stringValue(inner.args[1]) !== "" ||
				stringValue(test?.right) !== ""
			)
				return undefined;
		}
		return api.bind(guard.args[2] as FormSyntax, context);
	},
};

const condFold: Fold = {
	id: "cond",
	ruleSets: ["record"],
	propose(node, context, api) {
		const cond = call(node, "cond");
		if (
			cond === undefined ||
			cond.args.length < 3 ||
			cond.args.length % 2 !== 1
		)
			return undefined;
		const bound = cond.args.map((arg) => api.bind(arg, context));
		const values = bound.flatMap((_, index) =>
			index % 2 === 1 || index === bound.length - 1 ? [index] : [],
		);
		const typed = typedBranchLiterals(
			values.map((index) => ({
				syntax: cond.args[index] as FormSyntax,
				bound: bound[index] as Expression,
			})),
			context,
			api,
		);
		const args = bound.map((arg, index) => {
			const at = values.indexOf(index);
			return at === -1 ? arg : (typed[at] as Expression);
		});
		let result = args[args.length - 1] as Expression;
		for (let index = args.length - 3; index >= 0; index -= 2)
			result = {
				kind: "if",
				cond: args[index] as Expression,
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: args[index + 1] as Expression,
				else: result,
			};
		return api.remember(result, node);
	},
};

/** Whether every test of a guard's condition counts a set as absent: the
 *  joint guard `guardChecklistPair` writes around two paths. */
function countedAbsent(condition: FormSyntax): boolean {
	return clauses(condition, "and").every((test) =>
		clauses(test, "or").every((part) => absentCount(part) !== undefined),
	);
}

/** The branch positions of a lazy call: `if`'s two, and each value and the
 *  default of `cond`. */
function lazyBranches(node: Call): readonly number[] | undefined {
	if (node.name === "if" && node.args.length === 3) return [1, 2];
	if (
		node.name === "cond" &&
		node.args.length >= 3 &&
		node.args.length % 2 === 1
	)
		return node.args.flatMap((_, index) =>
			index % 2 === 1 || index === node.args.length - 1 ? [index] : [],
		);
	return undefined;
}

/** Whether a branch's syntax can bind to a `weighted-checklist` call in a
 *  form slot, by every fold that can give one: the call itself; a guard that
 *  `empty-rows-guard` (`if(count(…) > 0, X, '')`) or `handed-on-rows-guard`
 *  (`if(…, 0, X)`) unwraps to an `X` that can; this fold's own guard around
 *  the call; an `if` or `cond` every branch of which can, which this fold
 *  reads as the call. A branch this refuses binds to something else, so the
 *  fold declines the node before binding any of it. */
const checklistBranches = new WeakMap<FormSyntax, boolean>();
function mayBindChecklist(node: FormSyntax): boolean {
	// Each node is asked once: a node can be reached as a guard's branch and
	// as a lazy call's, and the answer depends on the syntax alone.
	const known = checklistBranches.get(node);
	if (known !== undefined) return known;
	const answer = checklistBranch(node);
	checklistBranches.set(node, answer);
	return answer;
}
function checklistBranch(node: FormSyntax): boolean {
	if (call(node, "weighted-checklist") !== undefined) return true;
	const guard = call(node, "if", 3);
	if (guard !== undefined) {
		const [condition, present, absent] = guard.args as [
			FormSyntax,
			FormSyntax,
			FormSyntax,
		];
		if (
			presentCount(condition) !== undefined &&
			(stringValue(absent) === "" || numberValue(absent) === 0) &&
			mayBindChecklist(present)
		)
			return true;
		if (numberValue(present) === 0 && mayBindChecklist(absent)) return true;
		if (
			call(absent, "weighted-checklist") !== undefined &&
			countedAbsent(condition)
		)
			return true;
	}
	const lazy = guard ?? call(node, "cond");
	if (lazy === undefined) return false;
	return (
		lazyBranches(lazy)?.every((index) =>
			mayBindChecklist(lazy.args[index] as FormSyntax),
		) === true
	);
}

const checklistGuard: Fold = {
	id: "checklist-guard",
	ruleSets: ["form"],
	propose(node, context, api) {
		const guard = call(node, "if", 3);
		const consumed = call(guard?.args[2], "weighted-checklist");
		if (
			guard !== undefined &&
			consumed !== undefined &&
			countedAbsent(guard.args[0] as FormSyntax)
		)
			return api.bind(consumed, context);
		// The call moved into the branches of an `if` or `cond` in its pair,
		// each branch guarded on its own: every branch binds to the call, and
		// the branches differ in one argument, which the lazy call chose.
		const lazy = call(node, "if", 3) ?? call(node, "cond");
		const branches = lazy === undefined ? undefined : lazyBranches(lazy);
		if (lazy === undefined || branches === undefined) return undefined;
		// Nothing is bound unless every branch can bind to the call: a plain
		// binding of the node binds every argument again, so binding them
		// for a chain of `if`s that are no checklist would double the work at
		// every level of the chain.
		if (
			!branches.every((index) =>
				mayBindChecklist(lazy.args[index] as FormSyntax),
			)
		)
			return undefined;
		const bound = lazy.args.map((arg) => api.bind(arg, context));
		const calls = branches.map((index) => bound[index]);
		const first = calls[0];
		if (
			first?.kind !== "call" ||
			first.fn !== "weighted-checklist" ||
			calls.some(
				(one) =>
					one?.kind !== "call" ||
					one.fn !== "weighted-checklist" ||
					one.args.length !== first.args.length,
			)
		)
			return undefined;
		const args = calls.map(
			(one) => (one as Extract<Expression, { kind: "call" }>).args,
		);
		const differing = first.args.flatMap((arg, index) =>
			args.every((others) => sameJson(others[index], arg)) ? [] : [index],
		);
		if (differing.length !== 1) return undefined;
		const at = differing[0] as number;
		const branchArg = new Map(
			branches.map((index, position) => [
				index,
				args[position]?.[at] as Expression,
			]),
		);
		const chosen: Expression[] = bound.map(
			(arg, index) => branchArg.get(index) ?? arg,
		);
		const choice: Expression =
			lazy.name === "if"
				? {
						kind: "if",
						cond: chosen[0] as Expression,
						// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
						then: chosen[1] as Expression,
						else: chosen[2] as Expression,
					}
				: { kind: "call", fn: "cond", args: chosen };
		return api.remember(
			{
				kind: "call",
				fn: "weighted-checklist",
				args: first.args.map((arg, index) =>
					index === at ? api.remember(choice, node) : arg,
				),
			},
			node,
		);
	},
};

/** The operand text an instant parse reads: the first argument of the
 *  `substr` inside its fraction term (`instant.ts::instantMicros`). */
function instantParseOperand(node: FormSyntax): FormSyntax | undefined {
	const sum = binary(node, "+");
	const fraction = call(sum?.right, "if", 3);
	const test = call(fraction?.args[0], "starts-with");
	const tail = call(test?.args[0], "substr");
	return tail?.args[0];
}

/** `X * 86400000000`, a day number as microseconds: X. */
function epochDayMicros(node: FormSyntax): FormSyntax | undefined {
	const product = binary(node, "*");
	return numberValue(product?.right) === 86_400_000_000
		? product?.left
		: undefined;
}

const INSTANT_TEXT_PATTERN = "%Y-%m-%dT%H:%M:%S.%3%Z";

/** One operand text of an instant parse, read by the spelling
 *  `instant.ts::spellingText` prints it as (`instantOperand.ts`,
 *  `InstantSpelling`): each spelling as the member `instantSpellingMember`
 *  gives it, which the canonical form gives too (`canonical.ts`,
 *  `instant-operand`). Form logic has no `datetime-coerce`, so there a
 *  midnight is read as the text it is. */
function instantOperandProposal(
	text: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
	opposite: () => Expression | undefined,
): Expression {
	const record = context.ruleSet === "record";
	const member = (spelling: InstantSpelling): Expression => {
		const read = instantSpellingMember(spelling, record);
		if (read === undefined) return api.bind(text, context);
		return read.kind === "term"
			? api.term(read.term, text)
			: read === (spelling as { value?: Expression }).value
				? read
				: api.remember(read, text);
	};
	const coerce = (
		of: "typed-date" | "date-text" | "day-number" | undefined,
		value: FormSyntax,
	): Expression => {
		if (!record) return api.bind(text, context);
		const bound = api.bind(value, context);
		return member(
			of === undefined
				? { kind: "text-or-midnight", value: bound }
				: { kind: "midnight", of, value: bound, guarded: false },
		);
	};
	const literal = stringValue(text);
	if (literal !== undefined)
		return member({ kind: "literal-text", text: literal });
	const typed = call(text, "format-date", 2);
	if (
		typed !== undefined &&
		stringValue(typed.args[1]) === INSTANT_TEXT_PATTERN
	) {
		const inner = call(typed.args[0], "coalesce", 2);
		if (inner !== undefined && stringValue(inner.args[1]) === "")
			return member({
				kind: "typed-text",
				value: api.bind(inner.args[0] as FormSyntax, context),
			});
	}
	const midnight = call(text, "concat", 2);
	if (
		midnight !== undefined &&
		stringValue(midnight.args[1])?.startsWith("T00:00:00")
	) {
		const day = call(midnight.args[0], "format-date", 2);
		const typedDay = call(day?.args[0], "coalesce", 2);
		if (typedDay !== undefined)
			return coerce("typed-date", typedDay.args[0] as FormSyntax);
		const dayNumber = call(day?.args[0], "date", 1);
		if (dayNumber !== undefined)
			return coerce("day-number", dayNumber.args[0] as FormSyntax);
		return coerce("date-text", midnight.args[0] as FormSyntax);
	}
	const branch = call(text, "if", 3);
	if (branch !== undefined) {
		const tenChars = binary(branch.args[0], "=");
		const length = call(tenChars?.left, "string-length", 1);
		if (
			length !== undefined &&
			numberValue(tenChars?.right) === 10 &&
			same(length.args[0], branch.args[2])
		)
			return coerce(undefined, length.args[0] as FormSyntax);
		const blank = binary(branch.args[0], "=");
		if (
			blank !== undefined &&
			stringValue(blank.right) === "" &&
			stringValue(branch.args[1]) === ""
		)
			return instantOperandProposal(
				branch.args[2] as FormSyntax,
				context,
				api,
				opposite,
			);
		const chain = record ? switchChain(text) : undefined;
		if (chain !== undefined) {
			// A record `switch` prints its cases' tests as written and each
			// result as an operand text, as `if` does.
			const on = api.bind(chain.subject, context);
			const cases = chain.tests.map(
				(test): SwitchCase => ({
					when: caseLiteral(test.value, on, context),
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: instantOperandProposal(test.then, context, api, opposite),
				}),
			);
			const [head, ...rest] = cases;
			if (head !== undefined)
				return api.remember(
					{
						kind: "switch",
						on,
						cases: [head, ...rest],
						fallback: instantOperandProposal(
							chain.fallback,
							context,
							api,
							opposite,
						),
					},
					text,
				);
		}
		return api.remember(
			{
				kind: "if",
				cond: api.bind(branch.args[0] as FormSyntax, context),
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: instantOperandProposal(
					branch.args[1] as FormSyntax,
					context,
					api,
					opposite,
				),
				else: instantOperandProposal(
					branch.args[2] as FormSyntax,
					context,
					api,
					opposite,
				),
			},
			text,
		);
	}
	const values = call(text, "coalesce");
	if (values !== undefined && values.args.length > 0) {
		const unwrapped = values.args.map((value) =>
			instantOperandProposal(value, context, api, opposite),
		);
		const [first, ...rest] = unwrapped;
		if (first !== undefined)
			return api.remember({ kind: "coalesce", values: [first, ...rest] }, text);
	}
	return api.bind(text, context);
}

const instantComparison: Fold = {
	id: "instant-comparison",
	ruleSets: ["form", "record"],
	propose(node, context, api) {
		const test = binary(node, [...COMPARISONS.keys()]);
		if (test === undefined) return undefined;
		const leftText = instantParseOperand(test.left);
		const rightText = instantParseOperand(test.right);
		if (leftText === undefined && rightText === undefined) return undefined;
		const record = context.ruleSet === "record";
		const side = (
			whole: FormSyntax,
			text: FormSyntax | undefined,
		): Expression | undefined => {
			if (text !== undefined)
				return instantOperandProposal(text, context, api, () => undefined);
			// A side printed as a number beside a parsed one: a count or a day
			// number's microseconds, each read as its spelling's member.
			const micros = numberValue(whole);
			const days = epochDayMicros(whole);
			const read =
				micros !== undefined && Number.isInteger(micros)
					? instantSpellingMember({ kind: "count", micros }, record)
					: days !== undefined && record
						? instantSpellingMember(
								{ kind: "scaled-days", value: api.bind(days, context) },
								record,
							)
						: undefined;
			if (read === undefined) return undefined;
			return read.kind === "term"
				? api.term(read.term, whole)
				: api.remember(read, whole);
		};
		const left = side(test.left, leftText);
		const right = side(test.right, rightText);
		if (left === undefined || right === undefined) return undefined;
		return api.remember(
			{ kind: COMPARISONS.get(test.op) as ComparisonKind, left, right },
			node,
		);
	},
};

/** `instant.ts::deviceInstantText`: date-and-time text read in the device's
 *  own date and clock before Core parses it, `if(substr(T, 10, 11) = 'T' and
 *  …, <the device's text>, T)`, written around a starting value cast into a
 *  date and time and around a `date()` or `format-date` operand that may
 *  hold such text. The proposal is the operand `T` itself, which the print
 *  wraps again where the emitter does. */
/** `node` with each untyped literal spelled as a date and time it gives,
 *  through the branches of an `if` or a `coalesce`, typed. */
function momentBranches(node: Expression): Expression {
	if (
		node.kind === "term" &&
		node.term.kind === "literal" &&
		node.term.data_type === undefined &&
		typeof node.term.value === "string" &&
		literalShape(node.term.value)?.type === "datetime"
	)
		return { kind: "term", term: { ...node.term, data_type: "datetime" } };
	if (node.kind === "if") {
		const then = momentBranches(node.then);
		const otherwise = momentBranches(node.else);
		return then === node.then && otherwise === node.else
			? node
			: { ...node, then, else: otherwise };
	}
	if (node.kind === "coalesce") {
		const values = node.values.map(momentBranches);
		return values.every((value, index) => value === node.values[index])
			? node
			: { ...node, values: values as typeof node.values };
	}
	return node;
}

const deviceInstantText: Fold = {
	id: "device-instant-text",
	ruleSets: ["form", "record"],
	propose(node, context, api) {
		const branch = call(node, "if", 3);
		if (branch === undefined) return undefined;
		const [first] = clauses(branch.args[0] as FormSyntax, "and");
		const test = binary(first, "=");
		const separator = call(test?.left, "substr", 3);
		const operand = branch.args[2];
		if (
			separator === undefined ||
			stringValue(test?.right) !== "T" ||
			numberValue(separator.args[1]) !== 10 ||
			numberValue(separator.args[2]) !== 11 ||
			!same(separator.args[0], operand)
		)
			return undefined;
		// A record literal is read in the device's own date only where it is
		// a typed date and time: the text of an untyped one prints as it is.
		// So is each literal spelled as a date and time a branch gives.
		const text = stringValue(operand);
		if (
			context.ruleSet === "record" &&
			text !== undefined &&
			literalShape(text)?.type === "datetime"
		)
			return api.term(
				{ kind: "literal", value: text, data_type: "datetime" },
				operand as FormSyntax,
			);
		const bound = api.bind(operand as FormSyntax, context);
		return context.ruleSet === "record" ? momentBranches(bound) : bound;
	},
};

const isBlank: Fold = {
	id: "is-blank",
	ruleSets: ["form", "record"],
	propose(node, context, api) {
		const test = binary(node, "=");
		const length = call(test?.left, "string-length", 1);
		const text = call(length?.args[0], "string", 1);
		if (text === undefined || numberValue(test?.right) !== 0) return undefined;
		return api.remember(
			{ kind: "is-blank", left: api.bind(text.args[0] as FormSyntax, context) },
			node,
		);
	},
};

const normalizeSpace: Fold = {
	id: "normalize-space",
	ruleSets: ["form", "record"],
	propose(node, context, api) {
		const outer = call(node, "replace", 3);
		const inner = call(outer?.args[0], "replace", 3);
		if (
			outer === undefined ||
			inner === undefined ||
			stringValue(outer.args[1]) === undefined ||
			stringValue(outer.args[2]) === undefined ||
			stringValue(inner.args[1]) === undefined ||
			stringValue(inner.args[2]) === undefined
		)
			return undefined;
		return api.remember(
			{
				kind: "call",
				fn: "normalize-space",
				args: [api.bind(inner.args[0] as FormSyntax, context)],
			},
			node,
		);
	},
};

const quotient: Fold = {
	id: "quotient",
	ruleSets: ["record"],
	propose(node, context, api) {
		const branch = call(node, "if", 3);
		const zero = binary(branch?.args[0], "=");
		const division = binary(branch?.args[1], "div");
		if (
			branch === undefined ||
			division === undefined ||
			numberValue(zero?.right) !== 0 ||
			!same(zero?.left, division.right)
		)
			return undefined;
		return api.remember(
			{
				kind: "arith",
				op: "quotient",
				left: api.bind(division.left, context),
				right: api.bind(division.right, context),
			},
			node,
		);
	},
};

const DATE_ADD_SCALES: readonly {
	readonly op: "*" | "div";
	readonly by: number;
	readonly interval: DateAddInterval;
}[] = [
	{ op: "*", by: 7, interval: "weeks" },
	{ op: "div", by: 24, interval: "hours" },
	{ op: "div", by: 1440, interval: "minutes" },
	{ op: "div", by: 86_400, interval: "seconds" },
];

const dateAdd: Fold = {
	id: "date-add",
	ruleSets: ["record"],
	propose(node, context, api) {
		const date = call(node, "date", 1);
		const floor = call(date?.args[0], "floor", 1);
		const sum = binary(floor?.args[0], "+");
		if (sum === undefined) return undefined;
		let quantity: FormSyntax = sum.right;
		let interval: DateAddInterval = "days";
		const scaled = binary(sum.right, ["*", "div"]);
		if (scaled !== undefined) {
			const scale = DATE_ADD_SCALES.find(
				(entry) =>
					entry.op === scaled.op && numberValue(scaled.right) === entry.by,
			);
			if (scale !== undefined) {
				quantity = scaled.left;
				interval = scale.interval;
			}
		}
		return api.remember(
			{
				kind: "date-add",
				date: api.bind(sum.left, context),
				interval,
				quantity: api.bind(quantity, context),
			},
			node,
		);
	},
};

/** A side of a comparison by day: a `casedb` `date_opened` or
 *  `last_modified` read of the row. */
function calendarRead(expression: Expression): boolean {
	const term = termOf(expression);
	return (
		term?.kind === "prop" &&
		(term.via === undefined || term.via.kind === "self") &&
		isCalendarCaseProperty(term.property)
	);
}

const datetimeValue: Fold = {
	id: "datetime-value",
	ruleSets: ["record"],
	propose(node, context, api) {
		// In a comparison by day a device holds a system date as a day, and
		// the emitter writes the other side's `datetime-coerce` as `date(V)`.
		const test = binary(node, [...COMPARISONS.keys()]);
		if (test !== undefined) {
			const leftDay = call(test.left, "date", 1);
			const rightDay = call(test.right, "date", 1);
			const day = rightDay ?? leftDay;
			if (
				day === undefined ||
				(leftDay !== undefined && rightDay !== undefined)
			)
				return undefined;
			const other = api.bind(
				rightDay !== undefined ? test.left : test.right,
				context,
			);
			if (!calendarRead(other)) return undefined;
			// The coercion reads text, so a literal it holds is read as the
			// text it is (`temporalLiterals.ts`).
			const value = api.bind(day.args[0] as FormSyntax, context);
			const coerced = api.remember({ kind: "datetime-coerce", value }, day);
			const kind = COMPARISONS.get(test.op) as ComparisonKind;
			return api.remember(
				rightDay !== undefined
					? { kind, left: other, right: coerced }
					: { kind, left: coerced, right: other },
				node,
			);
		}
		const branch = call(node, "if", 3);
		if (branch === undefined) return undefined;
		const blank = binary(branch.args[0], "=");
		if (
			blank !== undefined &&
			stringValue(blank.right) === "" &&
			stringValue(branch.args[1]) === ""
		)
			return api.remember(
				{ kind: "datetime-coerce", value: api.bind(blank.left, context) },
				node,
			);
		const tenChars = binary(branch.args[0], "=");
		const length = call(tenChars?.left, "string-length", 1);
		if (
			length !== undefined &&
			numberValue(tenChars?.right) === 10 &&
			same(length.args[0], branch.args[2])
		)
			return api.remember(
				{
					kind: "datetime-coerce",
					value: api.bind(length.args[0] as FormSyntax, context),
				},
				node,
			);
		return undefined;
	},
};

const whenInputPresent: Fold = {
	id: "when-input-present",
	ruleSets: ["record"],
	propose(node, context, api) {
		const branch = call(node, "if", 3);
		const counted = call(branch?.args[0], "count", 1);
		if (
			branch === undefined ||
			counted === undefined ||
			call(branch.args[2], "true", 0) === undefined
		)
			return undefined;
		const input = termOf(api.bind(counted.args[0] as FormSyntax, context));
		if (input?.kind !== "input") return undefined;
		return api.remember(
			{
				kind: "when-input-present",
				input,
				clause: api.bind(branch.args[1] as FormSyntax, context),
			},
			node,
		);
	},
};

/** A literal the source writes as one side of an equality: a string or a
 *  number, as the binder binds either. */
function literalValue(
	node: FormSyntax | undefined,
): string | number | undefined {
	return stringValue(node) ?? numberValue(node);
}

/** A value of an `in` or a case of a `switch`: a string typed by its own
 *  shape where it stands against a date or a date and time, a number as it
 *  is. */
function caseLiteral(
	value: string | number,
	on: Expression,
	context: ExpressionContext,
): Literal {
	return typeof value === "string"
		? shapedLiteral(value, on, context, false)
		: { kind: "literal", value };
}

const inFold: Fold = {
	id: "in",
	ruleSets: ["record"],
	propose(node, context, api) {
		const parts = clauses(node, "or");
		if (parts.length < 2) return undefined;
		const tests = parts.map((part) => binary(part, "="));
		const first = tests[0];
		if (first === undefined) return undefined;
		// Over moments each equality prints lowered to microseconds, which
		// binds as that equality, clause by clause.
		if (instantParseOperand(first.left) !== undefined) {
			const equalities = parts.map((part) => api.bind(part, context));
			const [head] = equalities;
			if (
				head?.kind !== "eq" ||
				!equalities.every(
					(one) => one.kind === "eq" && sameJson(one.left, head.left),
				)
			)
				return undefined;
			const literals = equalities.map((one) =>
				one.kind === "eq" ? termOf(one.right) : undefined,
			);
			if (!literals.every((one) => one?.kind === "literal")) return undefined;
			const [value, ...more] = literals as Literal[];
			return value === undefined
				? undefined
				: api.remember(
						{ kind: "in", left: head.left, values: [value, ...more] },
						node,
					);
		}
		const values: (string | number)[] = [];
		for (const test of tests) {
			const value = literalValue(test?.right);
			if (
				test === undefined ||
				value === undefined ||
				!same(test.left, first.left)
			)
				return undefined;
			values.push(value);
		}
		const left = api.bind(first.left, context);
		const literals = values.map((value) => caseLiteral(value, left, context));
		const [head, ...rest] = literals;
		if (head === undefined) return undefined;
		return api.remember({ kind: "in", left, values: [head, ...rest] }, node);
	},
};

/** Whether `node`, an `and` read as a range, is two top-level conjuncts of a
 *  list filter its search restates, which the search prints as a row each
 *  (`suite/case-search/xpathQuery.ts`), whatever they read: there a range
 *  prints one row and its two comparisons two, so the reading takes the
 *  comparisons and the search's rows say which the source holds
 *  (`search/rows.ts::classifySearchRows`, which reads one row as a run of the
 *  list's clauses, a date and time's range from a value to itself among
 *  them, which the row reads as the equality it also prints). Clauses are
 *  told by their place in the slot's whole source, which a value a device
 *  works out inside a row is not (`ExpressionReadEnv.rowValues`). */
function conjunctsPrintAsRows(
	node: FormSyntax,
	context: ExpressionContext,
	env: FoldEnv,
): boolean {
	if (
		context.slot.slot !== "case_list_filter" ||
		!context.profile.targets.has("CS") ||
		env.root === undefined
	)
		return false;
	const top = new Set(
		clauses(env.root, "and").map((clause) => `${clause.from}:${clause.to}`),
	);
	return clauses(node, "and").every((part) =>
		top.has(`${part.from}:${part.to}`),
	);
}

const between: Fold = {
	id: "between",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		const range = betweenOf(node, context, api);
		return range === undefined || conjunctsPrintAsRows(node, context, env)
			? undefined
			: api.remember(range, node);
	},
};

/** `node`, a lower bound's comparison and an upper bound's of one operand, as
 *  that range. */
function betweenOf(
	node: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
): Extract<Expression, { kind: "between" }> | undefined {
	const parts = clauses(node, "and");
	if (parts.length !== 2) return undefined;
	const lowerTest = binary(parts[0], [">=", ">"]);
	const upperTest = binary(parts[1], ["<=", "<"]);
	if (
		lowerTest === undefined ||
		upperTest === undefined ||
		!same(lowerTest.left, upperTest.left)
	)
		return undefined;
	// A range over moments prints each bound's comparison lowered to
	// microseconds, which binds as that comparison, clause by clause.
	if (
		[lowerTest.left, lowerTest.right, upperTest.right].some(
			(side) => instantParseOperand(side) !== undefined,
		)
	) {
		const lowerRead = api.bind(parts[0] as FormSyntax, context);
		const upperRead = api.bind(parts[1] as FormSyntax, context);
		const lower = momentPair(lowerRead, upperRead);
		const upper = momentPair(upperRead, lower);
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
	const left = api.bind(lowerTest.left, context);
	const bound = (side: FormSyntax): Expression => {
		const text = stringValue(side);
		return text === undefined
			? api.bind(side, context)
			: api.term(shapedLiteral(text, left, context, true), side);
	};
	return {
		kind: "between",
		left,
		lower: bound(lowerTest.right),
		upper: bound(upperTest.right),
		lowerInclusive: lowerTest.op === ">=",
		upperInclusive: upperTest.op === "<=",
	};
}

/** `bound`, a range's comparison of two moment literals, which a device
 *  compares as the two counts of microseconds they fold to and which binds as
 *  those numbers, with each count read as the literal it folds from, where
 *  `other`, the range's other comparison, holds a date-and-time literal of the
 *  first count as its operand: the range of that literal, which prints so. */
function momentPair(bound: Expression, other: Expression): Expression {
	if (!isComparisonNode(bound) || !isComparisonNode(other)) return bound;
	const count = numberLiteral(bound.left);
	const subject =
		other.left.kind === "term" &&
		other.left.term.kind === "literal" &&
		other.left.term.data_type === "datetime" &&
		typeof other.left.term.value === "string"
			? other.left.term.value
			: undefined;
	const bounded = numberLiteral(bound.right);
	if (
		count === undefined ||
		bounded === undefined ||
		subject === undefined ||
		literalInstantMicros(subject) !== count
	)
		return bound;
	const text = instantTextOfMicros(bounded);
	return text === undefined
		? bound
		: {
				...bound,
				left: other.left,
				right: {
					kind: "term",
					term: { kind: "literal", value: text, data_type: "datetime" },
				},
			};
}

function isComparisonNode(node: Expression): node is Expression & {
	readonly kind: "gt" | "gte" | "lt" | "lte";
	readonly left: Expression;
	readonly right: Expression;
} {
	return (
		node.kind === "gt" ||
		node.kind === "gte" ||
		node.kind === "lt" ||
		node.kind === "lte"
	);
}

function numberLiteral(node: Expression): number | undefined {
	return node.kind === "term" &&
		node.term.kind === "literal" &&
		typeof node.term.value === "number"
		? node.term.value
		: undefined;
}

/**
 * A distance test as a device prints it (`fromExpression.ts`,
 * `within-distance`): the property spelled as a location, the center a
 * location, both inside the globe's bounds, and `distance(property, center)`
 * at most the radius in meters. The radius is a number of meters where the
 * distance and its unit are both fixed, which reads as that many meters (the
 * canonical row `within-distance-in-meters`); the product of the distance and
 * one unit's meters, or of the distance and the choice of a unit worked out on
 * the device, otherwise.
 */
const withinDistance: Fold = {
	id: "within-distance",
	ruleSets: ["record"],
	propose(node, context, api) {
		// A device joins the test's clauses into an `and` around it
		// (`wire/builders.ts::logical`), so a test stands as a run of that
		// `and`'s clauses, each other clause its own.
		const parts = clauses(node, "and");
		if (!parts.some((_, at) => distanceRun(parts, at) !== undefined))
			return undefined;
		const read: Expression[] = [];
		for (let at = 0; at < parts.length; ) {
			const part = parts[at] as FormSyntax;
			const run = distanceRun(parts, at);
			if (run === undefined) {
				read.push(api.bind(part, context));
				at += 1;
				continue;
			}
			const test = distanceTest(run, context, api);
			if (test === undefined) return undefined;
			read.push(test);
			at = run.end + 1;
		}
		const [first, ...rest] = read;
		if (first === undefined) return undefined;
		return api.remember(
			rest.length === 0 ? first : { kind: "and", clauses: [first, ...rest] },
			node,
		);
	},
};

/** The run of `parts` from `start` that is one distance test as a device
 *  prints it: the property's shape test, the center's, and every clause up
 *  to the first `distance(property, …) <=` of the same property. */
function distanceRun(
	parts: readonly FormSyntax[],
	start: number,
):
	| {
			readonly shape: Call;
			readonly rawTest: Call;
			readonly radius: FormSyntax;
			readonly end: number;
	  }
	| undefined {
	const shape = call(parts[start], "regex", 2);
	const rawTest = call(parts[start + 1], "regex", 2);
	if (
		shape === undefined ||
		rawTest === undefined ||
		stringValue(shape.args[1] as FormSyntax) !== GEOPOINT_PROPERTY_PATTERN ||
		stringValue(rawTest.args[1] as FormSyntax) !== GEOPOINT_RAW_CENTER_PATTERN
	)
		return undefined;
	for (let end = start + 2; end < parts.length; end++) {
		const last = binary(parts[end], "<=");
		const measured = call(last?.left, "distance", 2);
		if (
			last !== undefined &&
			measured !== undefined &&
			same(shape.args[0] as FormSyntax, measured.args[0] as FormSyntax)
		)
			return { shape, rawTest, radius: last.right, end };
	}
	return undefined;
}

/** The `within-distance` a run of clauses prints. */
function distanceTest(
	run: NonNullable<ReturnType<typeof distanceRun>>,
	context: ExpressionContext,
	api: FoldApi,
): Expression | undefined {
	const property = api.bind(run.shape.args[0] as FormSyntax, context);
	if (property.kind !== "term" || property.term.kind !== "prop")
		return undefined;
	const radius = withinRadius(run.radius, context, api);
	if (radius === undefined) return undefined;
	return {
		kind: "within-distance",
		property: property.term,
		center: api.bind(run.rawTest.args[0] as FormSyntax, context),
		distance: radius.distance,
		unit: radius.unit,
	};
}

/** A distance test's radius in meters as its distance and unit. */
function withinRadius(
	node: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
):
	| {
			readonly distance: number | Expression;
			readonly unit: DistanceUnit | Expression;
	  }
	| undefined {
	const meters = numberValue(node);
	if (meters !== undefined) return { distance: meters, unit: "meters" };
	const product = binary(node, "*");
	if (product === undefined) return undefined;
	const fixed = numberValue(product.left);
	const read = call(product.left, "number", 1);
	const distance =
		fixed ??
		(read === undefined
			? undefined
			: api.bind(read.args[0] as FormSyntax, context));
	if (distance === undefined) return undefined;
	const factor = numberValue(product.right);
	if (factor !== undefined) {
		const unit = DISTANCE_UNITS.find(
			(name) => METERS_PER_DISTANCE_UNIT[name] === factor,
		);
		return unit === undefined ? undefined : { distance, unit };
	}
	const choice = call(product.right, "if", 3);
	const test = binary(choice?.args[0], "=");
	return test === undefined
		? undefined
		: { distance, unit: api.bind(test.left, context) };
}

/** A record `switch` as it prints: a chain of at least two `if`s, each
 *  testing one subject's equality with a literal, the last one's else the
 *  fallback. */
function switchChain(node: FormSyntax):
	| {
			readonly subject: FormSyntax;
			readonly tests: readonly {
				readonly value: string | number;
				readonly then: FormSyntax;
				readonly test: FormSyntax;
			}[];
			readonly fallback: FormSyntax;
	  }
	| undefined {
	const tests: {
		readonly value: string | number;
		readonly then: FormSyntax;
		readonly test: FormSyntax;
	}[] = [];
	let subject: FormSyntax | undefined;
	let at: FormSyntax = node;
	for (;;) {
		const branch = call(at, "if", 3);
		const test = binary(branch?.args[0], "=");
		const value = literalValue(test?.right);
		if (branch === undefined || test === undefined || value === undefined)
			break;
		if (subject === undefined) subject = test.left;
		else if (!same(subject, test.left)) break;
		tests.push({
			value,
			// biome-ignore lint/suspicious/noThenProperty: The branch is data, not a callable thenable.
			then: branch.args[1] as FormSyntax,
			test: branch.args[0] as FormSyntax,
		});
		at = branch.args[2] as FormSyntax;
	}
	return subject === undefined || tests.length < 2
		? undefined
		: { subject, tests, fallback: at };
}

const switchFold: Fold = {
	id: "switch",
	ruleSets: ["record"],
	propose(node, context, api) {
		const chain = switchChain(node);
		if (chain === undefined) return undefined;
		const { subject, tests, fallback: at } = chain;
		// Over moments each case's test prints lowered to microseconds, which
		// binds as that equality: its sides are the subject and the case.
		const lowered =
			instantParseOperand(subject) === undefined
				? undefined
				: tests.map((test) => api.bind(test.test, context));
		const on =
			lowered?.[0]?.kind === "eq"
				? lowered[0].left
				: api.bind(subject, context);
		if (
			lowered !== undefined &&
			!lowered.every(
				(one) =>
					one.kind === "eq" &&
					sameJson(one.left, on) &&
					termOf(one.right)?.kind === "literal",
			)
		)
			return undefined;
		const results = typedBranchLiterals(
			[...tests.map((test) => test.then), at].map((syntax) => ({
				syntax,
				bound: api.bind(syntax, context),
			})),
			context,
			api,
		);
		const cases = tests.map(
			(test, index): SwitchCase => ({
				when:
					lowered?.[index]?.kind === "eq"
						? (termOf(lowered[index].right) as Literal)
						: caseLiteral(test.value, on, context),
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: results[index] as Expression,
			}),
		);
		const [head, ...rest] = cases;
		if (head === undefined) return undefined;
		return api.remember(
			{
				kind: "switch",
				on,
				cases: [head, ...rest],
				fallback: results[tests.length] as Expression,
			},
			node,
		);
	},
};

/** An ancestor walk keyed from the row (`current()`, or the listed case's
 *  own walk): each hop `casedb/case[@case_id = <from>/index/<id> (and
 *  @case_type = 'T')]`, outermost last. */
function ancestorSteps(row: PathStep): RelationStep[] | undefined {
	const [where, ...more] = row.where;
	if (where === undefined || more.length > 0) return undefined;
	const both = binary(where, "and");
	const key = caseIdKey(both === undefined ? where : both.left);
	const throughCaseType =
		both === undefined ? undefined : caseTypeTest(both.right);
	if (
		key === undefined ||
		(both !== undefined && throughCaseType === undefined)
	)
		return undefined;
	const from = flat(key);
	if (from === undefined) return undefined;
	const tail = from.steps.slice(-2);
	if (
		tail.length !== 2 ||
		tail[0]?.name !== "index" ||
		tail[0].attribute ||
		tail[1] === undefined ||
		tail[1].attribute
	)
		return undefined;
	const step: RelationStep = {
		identifier: tail[1].name,
		...(throughCaseType === undefined ? {} : { throughCaseType }),
	};
	const origin: FlatPath = { ...from, steps: from.steps.slice(0, -2) };
	if (isCurrent(origin) && origin.steps.length === 0) return [step];
	if (origin.root === undefined && origin.steps.length === 0) return [step];
	if (instanceId(origin) === "casedb" && origin.steps.length === 2) {
		const inner = origin.steps[1];
		if (inner === undefined || inner.name !== "case") return undefined;
		const key0 = caseIdKey(inner.where[0]);
		if (
			inner.where.length === 1 &&
			key0 !== undefined &&
			sessionDatumRead(key0)
		)
			return [step];
		const outer = ancestorSteps(inner);
		return outer === undefined ? undefined : [...outer, step];
	}
	return undefined;
}

/** An ancestor walk a detail writes beside the listed case: each hop
 *  `current()/../case[@case_id = <from>/index/<id> (and @case_type = 'T')]`,
 *  keyed from `current()` or the hop before, outermost last. */
function siblingAncestorSteps(row: PathStep): RelationStep[] | undefined {
	const [where, ...more] = row.where;
	if (where === undefined || more.length > 0) return undefined;
	const both = binary(where, "and");
	const key = caseIdKey(both === undefined ? where : both.left);
	const throughCaseType =
		both === undefined ? undefined : caseTypeTest(both.right);
	if (
		key === undefined ||
		(both !== undefined && throughCaseType === undefined)
	)
		return undefined;
	const from = flat(key, true);
	const tail = from?.steps.slice(-2);
	if (
		from === undefined ||
		tail?.length !== 2 ||
		tail[0]?.name !== "index" ||
		tail[0].attribute ||
		tail[0].where.length > 0 ||
		tail[1] === undefined ||
		tail[1].attribute ||
		tail[1].where.length > 0
	)
		return undefined;
	const step: RelationStep = {
		identifier: tail[1].name,
		...(throughCaseType === undefined ? {} : { throughCaseType }),
	};
	const origin: FlatPath = { ...from, steps: from.steps.slice(0, -2) };
	if (isCurrent(origin) && origin.steps.length === 0) return [step];
	const [up, inner, ...rest] = origin.steps;
	if (
		!isCurrent(origin) ||
		up?.name !== PARENT_STEP ||
		up.where.length > 0 ||
		inner?.name !== "case" ||
		inner.attribute ||
		rest.length > 0
	)
		return undefined;
	const outer = siblingAncestorSteps(inner);
	return outer === undefined ? undefined : [...outer, step];
}

/** The ancestor walk a read of related case rows writes, `casedb`'s or a
 *  detail's beside the listed case, outermost last; undefined where the
 *  node reads no such walk. */
export function ancestorWalk(node: FormSyntax): RelationStep[] | undefined {
	const read = casedbRow(node);
	if (read !== undefined) return ancestorSteps(read.row);
	const sibling = siblingCaseRow(node);
	return sibling === undefined ? undefined : siblingAncestorSteps(sibling.row);
}

/** The case type a relation reaches, by its steps' own types and the
 *  catalog's `parent_type`. */
function destinationType(
	doc: BlueprintDoc,
	origin: string | undefined,
	steps: readonly RelationStep[],
): string | undefined {
	let at = origin;
	for (const step of steps) {
		if (step.throughCaseType !== undefined) at = step.throughCaseType;
		else
			at = (doc.caseTypes ?? []).find((type) => type.name === at)?.parent_type;
		if (at === undefined) return undefined;
	}
	return at;
}

const relationProperty: Fold = {
	id: "relation-property",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		const read = casedbRow(node);
		const sibling = read === undefined ? siblingCaseRow(node) : undefined;
		const rows = read ?? sibling;
		if (rows === undefined) return undefined;
		const [step, ...more] = rows.rest;
		const property = rowProperty(step);
		if (property === undefined || more.length > 0) return undefined;
		const steps =
			read === undefined
				? siblingAncestorSteps(rows.row)
				: ancestorSteps(read.row);
		if (steps === undefined) return undefined;
		if (
			steps.some(
				(hop) =>
					hop.identifier !== "parent" && hop.throughCaseType === undefined,
			)
		)
			return undefined;
		const [first, ...rest] = steps;
		if (first === undefined) return undefined;
		// A relation read names the case type it walks from, the row's.
		const row = activeRowScope(context);
		const caseType = row?.kind === "case" ? row.caseType : undefined;
		if (destinationType(env.doc, caseType, steps) === undefined)
			return undefined;
		return api.term(
			{
				kind: "prop",
				...(caseType === undefined ? {} : { caseType }),
				property,
				via: { kind: "ancestor", via: [first, ...rest] },
			},
			node,
		);
	},
};

/** One immediate relation test `rowScope.ts::immediateRelationPresence`
 *  writes, `count(I) > 0 and selected(join(' ', <candidates>/<ids>), I)`: an
 *  ancestor where `I` is the origin's `index/<id>` and the candidates give
 *  their `@case_id`, a subcase where `I` is the origin's id and the
 *  candidates give their `index/<id>`. `caseType` is the candidates' type
 *  test, and `where` the rest of their predicate. */
export interface PresenceShape {
	readonly kind: "ancestor" | "subcase";
	readonly identifier: string;
	readonly caseType?: string;
	readonly where: FormSyntax;
}
/** Clauses joined by `and` as the parser leans them, spanning the first
 *  clause's start to the last's end. */
export function joinedClauses(parts: readonly FormSyntax[]): FormSyntax {
	const [first, ...rest] = parts;
	if (first === undefined) throw new Error("No clauses to join.");
	return rest.reduce(
		(left, right) =>
			({
				kind: "binary",
				op: "and",
				left,
				right,
				from: left.from,
				to: right.to,
			}) as FormSyntax,
		first,
	);
}

export function presenceShape(node: FormSyntax): PresenceShape | undefined {
	const parts = clauses(node, "and");
	if (parts.length !== 2) return undefined;
	const counted = presentCount(parts[0]);
	const selected = call(parts[1], "selected", 2);
	const joined = call(selected?.args[0], "join", 2);
	if (
		counted === undefined ||
		joined === undefined ||
		!same(counted, selected?.args[1])
	)
		return undefined;
	const candidates = casedbRow(joined.args[1] as FormSyntax);
	const [condition, ...more] = candidates?.row.where ?? [];
	if (candidates === undefined || condition === undefined || more.length > 0)
		return undefined;
	// `@case_type = 'T' and <condition>`, which the parser leans left where
	// the condition is itself an `and`.
	const [head, ...tail] = clauses(condition, "and");
	const caseType =
		head === undefined || tail.length === 0 ? undefined : caseTypeTest(head);
	const where = caseType === undefined ? condition : joinedClauses(tail);
	const typedAs = caseType === undefined ? {} : { caseType };
	const [first, second, ...rest] = candidates.rest;
	if (first?.name === "case_id" && first.attribute && second === undefined) {
		const index = flat(counted)?.steps.slice(-2);
		if (
			index?.length !== 2 ||
			index[0]?.name !== "index" ||
			index[0].attribute ||
			index[1] === undefined ||
			index[1].attribute
		)
			return undefined;
		return { kind: "ancestor", identifier: index[1].name, ...typedAs, where };
	}
	if (
		first?.name === "index" &&
		!first.attribute &&
		second !== undefined &&
		!second.attribute &&
		rest.length === 0
	)
		return { kind: "subcase", identifier: second.name, ...typedAs, where };
	return undefined;
}

const relationPresence: Fold = {
	id: "relation-presence",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		// Inside a longer `and` the two halves of a test are two clauses of
		// the one chain the parser leans left, never a node of their own: each
		// run of two that is a test is its own site.
		const parts = clauses(node, "and");
		if (parts.length <= 2) return presenceProposal(node, context, api, env);
		// The runs that fold first, each binding only itself; the other
		// clauses are bound once one has, so an `and` this declines (any
		// with no test in it) has none of its clauses bound here, which the
		// plain binding binds once.
		const runs = new Map<number, Expression>();
		let index = 0;
		while (index < parts.length) {
			const first = parts[index] as FormSyntax;
			const second = parts[index + 1];
			if (second !== undefined) {
				const run = joinedClauses([first, second]);
				const proposal =
					presenceShape(run) !== undefined && env.use(run)
						? presenceProposal(run, context, api, env)
						: undefined;
				if (proposal !== undefined) {
					runs.set(index, proposal);
					index += 2;
					continue;
				}
			}
			index += 1;
		}
		if (runs.size === 0) return undefined;
		const bound: Expression[] = [];
		index = 0;
		while (index < parts.length) {
			const run = runs.get(index);
			if (run !== undefined) {
				bound.push(run);
				index += 2;
				continue;
			}
			bound.push(api.bind(parts[index] as FormSyntax, context));
			index += 1;
		}
		const [head, ...rest] = bound;
		if (head === undefined) return undefined;
		return api.remember({ kind: "and", clauses: [head, ...rest] }, node);
	},
};

function presenceProposal(
	node: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
	env: FoldEnv,
): Expression | undefined {
	const negated = call(node, "not", 1);
	const presence =
		negated === undefined ? node : (negated.args[0] as FormSyntax);
	// Over every relation of one index the emitter writes the ancestor's
	// test or the subcases' (`immediateRelationPresence`, `any-relation`).
	const either = binary(presence, "or");
	const up = either === undefined ? undefined : presenceShape(either.left);
	const down = either === undefined ? undefined : presenceShape(either.right);
	const one = either === undefined ? presenceShape(presence) : undefined;
	const row = activeRowScope(context);
	const origin = row?.kind === "case" ? row.caseType : undefined;
	let via: RelationPath;
	let shape: PresenceShape;
	let destination: string | undefined;
	if (one?.kind === "ancestor") {
		const step: RelationStep = {
			identifier: one.identifier,
			...(one.caseType === undefined ? {} : { throughCaseType: one.caseType }),
		};
		via = { kind: "ancestor", via: [step] };
		shape = one;
		destination = destinationType(env.doc, origin, [step]);
	} else if (one?.kind === "subcase") {
		via = {
			kind: "subcase",
			identifier: one.identifier,
			...(one.caseType === undefined ? {} : { ofCaseType: one.caseType }),
		};
		shape = one;
		destination = one.caseType;
	} else if (
		up?.kind === "ancestor" &&
		down?.kind === "subcase" &&
		up.identifier === down.identifier &&
		up.caseType === down.caseType
	) {
		via = {
			kind: "any-relation",
			identifier: down.identifier,
			...(down.caseType === undefined ? {} : { ofCaseType: down.caseType }),
		};
		shape = down;
		destination = down.caseType;
	} else return undefined;
	// A relation the catalog does not resolve is the checker's to refuse;
	// proposed, it would stop the emitter printing the form's other slots.
	// One it resolves is proposed typed as the catalog types it, the path every
	// target prints (`canonical.ts`, `relation-type`).
	try {
		const typed = canonicalizeRelationPath(via, {
			caseTypes: env.doc.caseTypes ?? [],
			...(origin === undefined ? {} : { currentCaseType: origin }),
		});
		via = typed.via;
		destination ??= typed.destinationCaseType;
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
	const bound =
		call(shape.where, "true", 0) !== undefined
			? undefined
			: api.bind(
					shape.where,
					pushRowScope(context, {
						kind: "case",
						root: "casedb",
						...(destination === undefined ? {} : { caseType: destination }),
					}),
				);
	return api.remember(
		{
			kind: negated === undefined ? "exists" : "missing",
			via,
			...(bound === undefined ? {} : { where: bound }),
		},
		node,
	);
}

/** `if(<presence>, 1, 0)`: the count over an ancestor relation
 *  (`fromExpression.ts::count`), the presence bound through the
 *  `relation-presence` fold. */
function ancestorCount(
	node: FormSyntax | undefined,
	context: ExpressionContext,
	api: FoldApi,
): Extract<Expression, { kind: "count" }> | undefined {
	const branch = call(node, "if", 3);
	if (
		branch === undefined ||
		numberValue(branch.args[1]) !== 1 ||
		numberValue(branch.args[2]) !== 0
	)
		return undefined;
	const presence = api.bind(branch.args[0] as FormSyntax, context);
	if (presence.kind !== "exists" || presence.via.kind !== "ancestor")
		return undefined;
	return {
		kind: "count",
		via: presence.via,
		...(presence.where === undefined ? {} : { where: presence.where }),
	};
}

const relationCount: Fold = {
	id: "relation-count",
	ruleSets: ["record"],
	propose(node, context, api) {
		const ancestor = ancestorCount(node, context, api);
		if (ancestor !== undefined) return api.remember(ancestor, node);
		// A count over every relation of one identifier: the ancestor's
		// presence as a number, plus the count of the subcases.
		const sum = binary(node, "+");
		if (sum !== undefined) {
			const up = ancestorCount(sum.left, context, api);
			const down =
				up === undefined || call(sum.right, "count", 1) === undefined
					? undefined
					: api.bind(sum.right, context);
			const [step, ...more] = up?.via.kind === "ancestor" ? up.via.via : [];
			if (
				up === undefined ||
				step === undefined ||
				more.length > 0 ||
				down?.kind !== "count" ||
				!isRelationPath(down.via) ||
				down.via.kind !== "subcase" ||
				down.via.identifier !== step.identifier ||
				down.via.ofCaseType !== step.throughCaseType
			)
				return undefined;
			return api.remember(
				{
					kind: "count",
					via: {
						kind: "any-relation",
						identifier: step.identifier,
						...(step.throughCaseType === undefined
							? {}
							: { ofCaseType: step.throughCaseType }),
					},
					...(down.where === undefined ? {} : { where: down.where }),
				},
				node,
			);
		}
		const counted = call(node, "count", 1);
		const rows =
			counted === undefined
				? undefined
				: casedbRow(counted.args[0] as FormSyntax);
		if (rows === undefined || rows.rest.length > 0) return undefined;
		const [link, ...filters] = rows.row.where;
		const typed = binary(link, "and");
		const indexTest = binary(typed === undefined ? link : typed.left, "=");
		const ofCaseType =
			typed === undefined ? undefined : caseTypeTest(typed.right);
		const index = indexTest === undefined ? undefined : flat(indexTest.left);
		if (
			index === undefined ||
			index.root !== undefined ||
			index.steps.length !== 2 ||
			index.steps[0]?.name !== "index" ||
			(typed !== undefined && ofCaseType === undefined)
		)
			return undefined;
		const identifier = index.steps[1]?.name as string;
		const scope = pushRowScope(context, {
			kind: "case",
			root: "casedb",
			...(ofCaseType === undefined ? {} : { caseType: ofCaseType }),
		});
		const bound = filters.map((filter) => api.bind(filter, scope));
		const [first, ...rest] = bound;
		return api.remember(
			{
				kind: "count",
				via: {
					kind: "subcase",
					identifier,
					...(ofCaseType === undefined ? {} : { ofCaseType }),
				},
				...(first === undefined
					? {}
					: {
							where:
								rest.length === 0
									? first
									: { kind: "and", clauses: [first, ...rest] },
						}),
			},
			node,
		);
	},
};

/** Every fold, in the order a slot is offered them: the literal folds, the
 *  identity leaves, then the lowerings read back. */
export const EXPRESSION_FOLDS: readonly Fold[] = [
	protectedLiteral,
	typedLiteral,
	formRead,
	ownCaseRead,
	workerRecordRead,
	operationId,
	actingUser,
	unowned,
	ownerAtLevel,
	absentNodeGuard,
	searchText,
	emptyRowsGuard,
	handedOnRowsGuard,
	condFold,
	checklistGuard,
	instantComparison,
	deviceInstantText,
	isBlank,
	normalizeSpace,
	quotient,
	dateAdd,
	datetimeValue,
	whenInputPresent,
	inFold,
	between,
	withinDistance,
	switchFold,
	typedBranchLiteral,
	blankBranch,
	relationProperty,
	relationPresence,
	relationCount,
];
