/**
 * The folds: each proposes a typed arm for a syntax shape an app's text
 * holds, the spelling Nova's emitter writes for that arm (a lowering, a
 * guard, an identity leaf). A proposer reads the node's shape only as far
 * as it needs to build the proposal and proves nothing: the slot's print
 * does, and a proposal whose print differs is withdrawn at its site. A
 * proposer never looks at a name to decide.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { reachableCaseTypes } from "@/lib/domain/caseTypes";
import {
	activeRowScope,
	type ExpressionContext,
	pushRowScope,
} from "@/lib/domain/expression/context";
import {
	instantTextOfMicros,
	literalInstantMicros,
} from "@/lib/domain/expression/instantOperand";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import type { RuleSet } from "@/lib/domain/expression/profiles";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import {
	type ComparisonKind,
	type DateAddInterval,
	type Expression,
	type FormNodeRef,
	isRelationPath,
	type Literal,
	type RelationPath,
	type RelationStep,
	type SwitchCase,
	type Term,
} from "@/lib/domain/expression/types";
import { organizationLevelsOf } from "@/lib/domain/organization";
import type { Uuid } from "@/lib/domain/uuid";
import type { FormNodeProjection } from "../../xpath/formNodeProjection";
import type { FoldApi } from "../../xpath/formParseScope";
import { type FormSyntax, formSyntaxKey } from "../../xpath/formSyntax";
import { formUserProperty } from "../../xpath/referenceBindings";
import { crossesSourceRepeatInRowPredicate } from "../../xpath/wire/formReads";

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
	/** Fold sites withdrawn so far, as `foldId:from:to` of this slot's source. */
	readonly withdrawn: ReadonlySet<string>;
	/** The form-node projection the slot's paths bind through, where the slot
	 *  reads a form. */
	readonly projection?: FormNodeProjection;
	/** Claims a site of its own for this fold over `span` (a fold that folds
	 *  several runs of one node, each its own site): false where that site is
	 *  withdrawn. A fold that claims none takes the node's own span. */
	use(span: { readonly from: number; readonly to: number }): boolean;
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

/** A path read as its root and named steps, or undefined where the node is
 *  no path of plain named steps. Structural, never textual. */
export function flat(node: FormSyntax): FlatPath | undefined {
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
				: flat(at.left);
		if (left === undefined) return undefined;
		const right = flat(at.step);
		if (right === undefined || right.root !== undefined) return undefined;
		return { ...left, steps: [...left.steps, ...right.steps] };
	}
	if (at.kind === "filter") {
		const base = flat(at.base);
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

const COMPARISONS: Readonly<Record<string, ComparisonKind>> = {
	"=": "eq",
	"!=": "neq",
	">": "gt",
	">=": "gte",
	"<": "lt",
	"<=": "lte",
};
const ORDERINGS: ReadonlySet<string> = new Set([">", ">=", "<", "<="]);

/** A record literal typed by its own shape, where it stands against a date
 *  or a date and time, or in an ordering against a value of no known type:
 *  a date or a date and time literal Nova stores typed prints the same bytes
 *  as the untyped one, and only the typed one passes the checker. The search
 *  row reader types a CSQL string by the same rule. */
export function shapedLiteral(
	value: string,
	opposite: Expression | undefined,
	context: ExpressionContext,
	ordering: boolean,
): Literal {
	const shape = literalShape(value);
	if (shape === undefined || shape.type === "time")
		return { kind: "literal", value };
	const other =
		opposite === undefined
			? undefined
			: scalarDataType(typeOf(opposite, context)?.data);
	const known = other !== undefined && other !== "_any";
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
		const parts: Expression[] = [];
		let joined = false;
		let index = 0;
		while (index < concat.args.length) {
			let end = index;
			while (
				end < concat.args.length &&
				literalPiece(concat.args[end] as FormSyntax) !== undefined
			)
				end++;
			const run = concat.args.slice(index, end);
			const first = run[0];
			const last = run.at(-1);
			if (
				run.length >= 2 &&
				first !== undefined &&
				last !== undefined &&
				env.use({ from: first.from, to: last.to })
			) {
				const value = run.map((piece) => literalPiece(piece)).join("");
				parts.push(
					api.term({ kind: "literal", value }, {
						...first,
						to: last.to,
					} as FormSyntax),
				);
				joined = true;
				index = end;
				continue;
			}
			const arg = concat.args[index] as FormSyntax;
			for (const piece of end > index ? run : [arg])
				parts.push(api.bind(piece, context));
			index = end > index ? end : index + 1;
		}
		if (!joined) return undefined;
		const [only, ...more] = parts;
		if (only === undefined) return undefined;
		if (more.length === 0) return only;
		return api.remember({ kind: "concat", parts: [only, ...more] }, node);
	},
};

const typedLiteral: Fold = {
	id: "typed-literal",
	ruleSets: ["record"],
	propose(node, context, api) {
		const test = binary(node, Object.keys(COMPARISONS));
		if (test === undefined) return undefined;
		const leftText = stringValue(test.left);
		const rightText = stringValue(test.right);
		if (leftText === undefined && rightText === undefined) return undefined;
		const literalSide = leftText !== undefined ? "left" : "right";
		const text = (leftText ?? rightText) as string;
		const shape = literalShape(text);
		if (shape === undefined || shape.type === "time") return undefined;
		const other = api.bind(
			literalSide === "left" ? test.right : test.left,
			context,
		);
		const literal = shapedLiteral(text, other, context, ORDERINGS.has(test.op));
		if (literal.data_type === undefined) return undefined;
		const kind = COMPARISONS[test.op] as ComparisonKind;
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

// ── Identity leaves ──────────────────────────────────────────────────

const formRead: Fold = {
	id: "form-read",
	ruleSets: ["form", "record"],
	propose(node, context, api, env) {
		// A Save to Case block reads an answer of its own repeat from the node
		// it stands in, through `current()`.
		const placed = env.place?.fields.get(formSyntaxKey(core(node)));
		if (placed !== undefined)
			return api.term({ kind: "field", uuid: placed }, node);
		const path = flat(node);
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
		const target: FormNodeRef =
			read.kind === "field"
				? {
						kind: "field",
						uuid: read.uuid,
						...(read.role === undefined ? {} : { role: read.role }),
					}
				: {
						kind: "repeat-row",
						repeat: read.repeat,
						attribute: read.attribute,
					};
		const coordinates = env.projection?.graph.path(target);
		const relocated =
			(context.slot.entity === "field" &&
				context.slot.slot === "default_value") ||
			(coordinates !== undefined &&
				env.projection !== undefined &&
				crossesSourceRepeatInRowPredicate(
					coordinates,
					context,
					env.projection,
				));
		const { spelling: _absolute, ...rest } = read;
		const term = (relocated ? { ...rest, spelling: "current" } : rest) as Term;
		return { kind: "term", term };
	},
};

/** The depth of an own-case walk keyed at `key`: 0 where the key reads a
 *  session datum, one more for each `…/index/parent` hop around it. */
export function ownCaseDepth(key: FormSyntax | undefined): number | undefined {
	if (key === undefined) return undefined;
	if (sessionDatumRead(key)) return 0;
	const hop = casedbRow(key);
	if (hop === undefined || hop.row.where.length !== 1) return undefined;
	const [index, parent, ...more] = hop.rest;
	if (
		more.length > 0 ||
		index?.name !== "index" ||
		index.attribute ||
		parent?.name !== "parent" ||
		parent.attribute
	)
		return undefined;
	const inner = ownCaseDepth(caseIdKey(hop.row.where[0]));
	return inner === undefined ? undefined : inner + 1;
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
		const read = casedbRow(node);
		if (read === undefined || read.row.where.length !== 1) return undefined;
		const [step, ...more] = read.rest;
		const property = rowProperty(step);
		if (property === undefined || more.length > 0) return undefined;
		const depth = ownCaseDepth(caseIdKey(read.row.where[0]));
		if (depth === undefined) return undefined;
		const moduleUuid = context.form?.moduleUuid;
		const moduleCaseType =
			moduleUuid === undefined
				? undefined
				: env.doc.modules[moduleUuid]?.caseType;
		if (context.ruleSet === "record") {
			if (depth !== 0 || moduleCaseType === undefined) return undefined;
			return api.term(
				{ kind: "prop", caseType: moduleCaseType, property },
				node,
			);
		}
		const reachable = reachableCaseTypes(
			moduleCaseType,
			env.doc.caseTypes ?? [],
		).find((type) => type.depth === depth);
		if (reachable === undefined) return undefined;
		return api.term(
			{ kind: "form-case", caseType: reachable.name, property },
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

const operationId: Fold = {
	id: "operation-id",
	ruleSets: ["record"],
	propose(node, context, api, env) {
		if (!isCaseOperationSlot(context)) return undefined;
		// Nova reads an earlier create's id from the node the block's
		// expression stands in, through `current()`; a source may name it by
		// its absolute path.
		const path = flat(node);
		const text = path === undefined ? undefined : absoluteText(path);
		const opUuid =
			env.place?.operationIds.get(formSyntaxKey(core(node))) ??
			(text === undefined ? undefined : env.operationIdPaths.get(text));
		return opUuid === undefined
			? undefined
			: api.remember({ kind: "id-of", opUuid }, node);
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
				: context.facts.operationCaseTypes.get(operation);
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
function clauses(node: FormSyntax, op: "and" | "or"): FormSyntax[] {
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
		const args = cond.args.map((arg) => api.bind(arg, context));
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
			args.every(
				(others) => JSON.stringify(others[index]) === JSON.stringify(arg),
			)
				? []
				: [index],
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

/** One operand text of an instant parse, unwrapped by the spellings
 *  `instant.ts::leafText` and `::operandText` write. */
function instantOperandProposal(
	text: FormSyntax,
	context: ExpressionContext,
	api: FoldApi,
	opposite: () => Expression | undefined,
): Expression {
	const record = context.ruleSet === "record";
	const coerce = (value: FormSyntax): Expression =>
		record
			? api.remember(
					{ kind: "datetime-coerce", value: api.bind(value, context) },
					text,
				)
			: api.bind(text, context);
	const literal = stringValue(text);
	if (literal !== undefined)
		return api.term(
			record
				? { kind: "literal", value: literal, data_type: "datetime" }
				: { kind: "literal", value: literal },
			text,
		);
	const typed = call(text, "format-date", 2);
	if (
		typed !== undefined &&
		stringValue(typed.args[1]) === INSTANT_TEXT_PATTERN
	) {
		const inner = call(typed.args[0], "coalesce", 2);
		if (inner !== undefined && stringValue(inner.args[1]) === "")
			return api.bind(inner.args[0] as FormSyntax, context);
	}
	const midnight = call(text, "concat", 2);
	if (
		midnight !== undefined &&
		stringValue(midnight.args[1])?.startsWith("T00:00:00")
	) {
		const day = call(midnight.args[0], "format-date", 2);
		const typedDay = call(day?.args[0], "coalesce", 2);
		if (typedDay !== undefined) return coerce(typedDay.args[0] as FormSyntax);
		const dayNumber = call(day?.args[0], "date", 1);
		if (dayNumber !== undefined) return coerce(dayNumber.args[0] as FormSyntax);
		return coerce(midnight.args[0] as FormSyntax);
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
			return coerce(length.args[0] as FormSyntax);
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
		const test = binary(node, Object.keys(COMPARISONS));
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
			const micros = numberValue(whole);
			if (micros !== undefined && Number.isInteger(micros)) {
				const literal = instantTextOfMicros(micros);
				if (literal === undefined || literalInstantMicros(literal) !== micros)
					return undefined;
				return api.term(
					record
						? { kind: "literal", value: literal, data_type: "datetime" }
						: { kind: "literal", value: literal },
					whole,
				);
			}
			const days = epochDayMicros(whole);
			if (days !== undefined && record)
				return api.remember(
					{ kind: "datetime-coerce", value: api.bind(days, context) },
					whole,
				);
			return undefined;
		};
		const left = side(test.left, leftText);
		const right = side(test.right, rightText);
		if (left === undefined || right === undefined) return undefined;
		return api.remember(
			{ kind: COMPARISONS[test.op] as ComparisonKind, left, right },
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
		return api.bind(operand as FormSyntax, context);
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

const datetimeValue: Fold = {
	id: "datetime-value",
	ruleSets: ["record"],
	propose(node, context, api) {
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

const between: Fold = {
	id: "between",
	ruleSets: ["record"],
	propose(node, context, api) {
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
		const left = api.bind(lowerTest.left, context);
		const bound = (side: FormSyntax): Expression => {
			const text = stringValue(side);
			return text === undefined
				? api.bind(side, context)
				: api.term(shapedLiteral(text, left, context, true), side);
		};
		return api.remember(
			{
				kind: "between",
				left,
				lower: bound(lowerTest.right),
				upper: bound(upperTest.right),
				lowerInclusive: lowerTest.op === ">=",
				upperInclusive: upperTest.op === "<=",
			},
			node,
		);
	},
};

const switchFold: Fold = {
	id: "switch",
	ruleSets: ["record"],
	propose(node, context, api) {
		const tests: {
			readonly value: string | number;
			readonly then: FormSyntax;
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
			// biome-ignore lint/suspicious/noThenProperty: The branch is data, not a callable thenable.
			tests.push({ value, then: branch.args[1] as FormSyntax });
			at = branch.args[2] as FormSyntax;
		}
		if (subject === undefined || tests.length < 2) return undefined;
		const on = api.bind(subject, context);
		const cases = tests.map(
			(test): SwitchCase => ({
				when: caseLiteral(test.value, on, context),
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: api.bind(test.then, context),
			}),
		);
		const [head, ...rest] = cases;
		if (head === undefined) return undefined;
		return api.remember(
			{
				kind: "switch",
				on,
				cases: [head, ...rest],
				fallback: api.bind(at, context),
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
		if (read === undefined) return undefined;
		const [step, ...more] = read.rest;
		const property = rowProperty(step);
		if (property === undefined || more.length > 0) return undefined;
		const steps = ancestorSteps(read.row);
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
interface PresenceShape {
	readonly kind: "ancestor" | "subcase";
	readonly identifier: string;
	readonly caseType?: string;
	readonly where: FormSyntax;
}
function presenceShape(node: FormSyntax): PresenceShape | undefined {
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
	const typed = binary(condition, "and");
	const caseType = typed === undefined ? undefined : caseTypeTest(typed.left);
	const where = caseType === undefined ? condition : (typed as Binary).right;
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
				...(one.caseType === undefined
					? {}
					: { throughCaseType: one.caseType }),
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
		try {
			canonicalizeRelationPath(via, {
				caseTypes: env.doc.caseTypes ?? [],
				...(origin === undefined ? {} : { currentCaseType: origin }),
			});
		} catch {
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
	},
};

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
	switchFold,
	relationProperty,
	relationPresence,
	relationCount,
];
