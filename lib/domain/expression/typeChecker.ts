/** One semantic walk over the stored expression tree. Slot admission, scalar
 * rules and native held classes share the same lexical contexts and cache. */
import type { CasePropertyDataType } from "../casePropertyTypes";
import { COMMCARE_DATE_PATTERN_REGEX } from "../commCareDatePattern";
import {
	FUNCTION_REGISTRY,
	type FunctionSpec,
	functionArityIssue,
} from "../expressionFunctions";
import { STANDARD_CASE_LIST_PROPERTY_DATA_TYPES } from "../standardCaseProperties";
import type { Uuid } from "../uuid";
import { type ExpressionChild, expressionChildren } from "./children";
import { selectAnswerTokens } from "./choiceValue";
import {
	activeRowScope,
	type ExpressionContext,
	type FormExpressionFacts,
	pushRowScope,
	type RecordQueryContext,
	type RecordQueryRowScope,
	type RowScope,
	type TypingContext,
	withFormContextNode,
} from "./context";
import { fixedDatePattern, isIsoDateText } from "./datePattern";
import { formNodeGraph } from "./formNodes";
import { numericAnswerText } from "./numberLiteral";
import { resolveRelationDestination } from "./relationDestination";
import {
	ANY_TYPE,
	accumulateBranchType,
	describe,
	isDateOrDatetime,
	isNumeric,
	isWriteAssignable,
	literalShape,
	literalType,
	MATCH_PROPERTY_TYPES_BY_MODE,
	ORDERED_TYPES,
	type RecordPosition,
	recordPositionVerdict,
	TEXT_SHAPED_TYPES,
	TIME_ORDERING_MESSAGE,
	typesCompatible,
} from "./ruleSets";
import {
	type CheckPath,
	type ComparisonKind,
	datumRefKey,
	type Expression,
	type FormNodeRef,
	formNodeKey,
	isConditionArm,
	isExpression,
	isRelationPath,
	type Literal,
	type Term,
} from "./types";

export type ScalarType = CasePropertyDataType | "boolean" | "_any";
export type ExpressionType =
	| ScalarType
	| {
			readonly nodes: ScalarType | "case" | "table" | "location" | "repeat";
			readonly cardinality: "one" | "many";
			/** Several nodes by the app's shape, not its data: a form read that
			 * crosses a repeat its context is not inside, or `selected-cases`. */
			readonly structural?: true;
			/** A group, section, form root or Connect block: a container node,
			 * whose text value is its descendants' text. */
			readonly container?: true;
	  }
	| "sequence";
export type Held =
	| "boolean"
	| "number"
	| "string"
	| "date"
	| { readonly nodes: "boolean" | "number" | "string" | "date" }
	| "sequence";
/** What one scalar value or one node unpacks to. */
export type ScalarHeld = Exclude<Held, object | "sequence">;
/** Why a node-set holds several values by the app's shape. */
export type StructuralSource =
	| { readonly reason: "repeat"; readonly repeat: Uuid }
	| { readonly reason: "selected-cases"; readonly module: Uuid };
export interface NodeType {
	readonly data: ExpressionType;
	readonly held: Held;
	readonly caseIdOf?: string;
	/** A date and time that may hold only its day: some value it can be is a
	 * Hidden Value whose clock is gone (`inference.ts`). */
	readonly clockLost?: true;
	/** Present on a structurally several-valued node-set, and on the result of
	 * a position that passes one through (`if` and `switch` branches, the last
	 * `coalesce` argument, a function's pass-through argument). */
	readonly several?: StructuralSource;
}
export type CheckErrorCode =
	| "unknown-property"
	| "unknown-search-input"
	| "unknown-form-field"
	| "unknown-user-property"
	| "unknown-lookup-table"
	| "unknown-lookup-column"
	| "lookup-table-scope"
	| "unknown-operation-id"
	| "operation-context-value"
	| "unknown-case-type"
	| "property-scope"
	| "case-status-value"
	| "incompatible-values"
	| "ordered-values"
	| "time-ordering"
	| "location-value"
	| "match-value"
	| "match-value-empty"
	| "multi-select-property"
	| "pattern-match-unavailable"
	| "range-order"
	| "relation-origin"
	| "relation-self"
	| "relation-path"
	| "relation-destination"
	| "relation-ambiguous"
	| "date-value"
	| "number-value"
	| "text-or-date-value"
	| "text-or-number-value"
	| "branch-values"
	| "text-value"
	| "expected-value"
	| "constraint-value"
	| "default-not-a-choice"
	| "arm-unavailable"
	| "case-data-unavailable"
	| "form-answer-unavailable"
	| "search-answer-unavailable"
	| "row-scope"
	| "datum-not-supplied"
	| "record-position"
	| "many-values"
	| "datetime-literal-precision"
	| "format-date-pattern-not-fixed";
export interface CheckError {
	readonly path: CheckPath;
	readonly code: CheckErrorCode;
	readonly message: string;
	readonly reason?: string;
	/** On `many-values`: the repeat or menu that makes the read several. */
	readonly several?: StructuralSource;
}
export interface CheckOutcome {
	readonly type: NodeType | undefined;
	readonly errors: readonly CheckError[];
}
export {
	ALL_RESOLVED_TYPES,
	ANY_TYPE,
	comparisonObjectTypesFor,
	comparisonOperatorsFor,
	compatibleTypesFor,
	describe,
	type ExpressionResultClass,
	isDateOrDatetime,
	isNumeric,
	isValueStorageAssignable,
	literalType,
	MATCH_PROPERTY_TYPES_BY_MODE,
	matchModesFor,
	ORDERED_TYPES,
	type ResolvedType,
	TEXT_SHAPED_TYPES,
	typesCompatible,
	type ValueExpressionResultClass,
	valueExpressionKindResultClass,
} from "./ruleSets";
export type { CheckPath } from "./types";

export function scalarDataType(
	data: ExpressionType | undefined,
): ScalarType | undefined {
	if (data === undefined || data === "sequence") return undefined;
	if (typeof data === "string") return data;
	return ["case", "table", "location", "repeat"].includes(data.nodes)
		? undefined
		: (data.nodes as ScalarType);
}
function scalarHeld(data: ScalarType): ScalarHeld {
	return data === "boolean"
		? "boolean"
		: isNumeric(data)
			? "number"
			: data === "date" || data === "datetime"
				? "date"
				: "string";
}
function scalar(
	data: ScalarType,
	held: Held = scalarHeld(data),
	caseIdOf?: string,
): NodeType {
	return { data, held, ...(caseIdOf === undefined ? {} : { caseIdOf }) };
}
function nodes(
	data: ScalarType | "case" | "table" | "location" | "repeat",
	held: ScalarHeld = "string",
	cardinality: "one" | "many" = "one",
	caseIdOf?: string,
): NodeType {
	return {
		data: { nodes: data, cardinality },
		held: { nodes: held },
		...(caseIdOf === undefined ? {} : { caseIdOf }),
	};
}
/** A node-set the app's shape makes several-valued. */
function severalNodes(
	type: NodeType,
	several: StructuralSource | undefined,
): NodeType {
	if (several === undefined || typeof type.data !== "object") return type;
	return {
		...type,
		data: { ...type.data, cardinality: "many", structural: true },
		several,
	};
}
function caseScope(
	ctx: TypingContext,
): Extract<RowScope | RecordQueryRowScope, { kind: "case" }> | undefined {
	const row = activeRowScope(ctx);
	return row?.kind === "case"
		? row
		: row?.kind === "table"
			? row.capturedCase
			: undefined;
}
function rebind(
	ctx: TypingContext,
	row: RowScope | RecordQueryRowScope,
): TypingContext {
	if ("kind" in ctx) {
		if (row.kind === "repeat")
			throw new Error("A record query cannot bind a form repeat row.");
		const queryRow: RecordQueryRowScope =
			row.kind === "case"
				? { kind: "case", caseType: row.caseType }
				: row.kind === "location"
					? { kind: "location" }
					: {
							kind: "table",
							tableId: row.tableId,
							...(row.capturedCase === undefined
								? {}
								: {
										capturedCase: {
											kind: "case",
											caseType: row.capturedCase.caseType,
										},
									}),
						};
		return pushRowScope(ctx, queryRow);
	}
	if (!("root" in row))
		throw new Error("An authored expression row is missing its instance root.");
	return pushRowScope(ctx, row);
}
function withCase(
	ctx: TypingContext,
	caseType: string | undefined,
): TypingContext {
	const active = caseScope(ctx);
	return rebind(ctx, {
		kind: "case",
		root: active !== undefined && "root" in active ? active.root : "casedb",
		...(caseType === undefined ? {} : { caseType }),
	});
}

const cached = new WeakMap<
	TypingContext,
	WeakMap<Expression, Map<RecordPosition | undefined, CheckOutcome>>
>();
/** Each node's walk records its children's types by path, so the one
 * consumption rule below reads them without walking a second time. */
const childTypes = new WeakMap<
	CheckError[],
	Map<string, NodeType | undefined>
>();
const pathKey = (path: CheckPath): string => JSON.stringify(path);
function infer(
	expression: Expression,
	ctx: TypingContext,
	position?: RecordPosition,
): CheckOutcome {
	let byNode = cached.get(ctx);
	if (byNode === undefined) {
		byNode = new WeakMap();
		cached.set(ctx, byNode);
	}
	let byPosition = byNode.get(expression);
	if (byPosition === undefined) {
		byPosition = new Map();
		byNode.set(expression, byPosition);
	}
	const present = byPosition.get(position);
	if (present !== undefined) return present;
	const errors: CheckError[] = [];
	// A calculated generated node can read its own source while a candidate is
	// being validated. The dependency checker reports the cycle; inference
	// remains unknown rather than recursively manufacturing a type.
	byPosition.set(position, { type: undefined, errors: [] });
	const refusal = admission(expression, ctx, position);
	if (refusal !== undefined) {
		const outcome = { type: undefined, errors: [refusal] };
		byPosition.set(position, outcome);
		return outcome;
	}
	if (ctx.ruleSet === "record" && position !== undefined) {
		const verdict = recordPositionVerdict(expression.kind, position);
		if (!verdict.ok)
			errors.push({
				path: [],
				code: "record-position",
				reason: verdict.reason,
				message:
					verdict.reason === "value-expected"
						? "This position takes a value."
						: "This position takes a condition. Compare this value with something.",
			});
	}
	childTypes.set(errors, new Map());
	const type = settle(
		expression,
		ctx,
		errors,
		inferNode(expression, ctx, errors, position),
	);
	const outcome = { type, errors };
	byPosition.set(position, outcome);
	return outcome;
}
function inferAt(
	expression: Expression,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
	position?: RecordPosition,
): NodeType | undefined {
	const outcome = infer(expression, ctx, position);
	for (const error of outcome.errors)
		errors.push({ ...error, path: [...path, ...error.path] });
	childTypes.get(errors)?.set(pathKey(path), outcome.type);
	return outcome.type;
}
function inferScalar(
	expression: Expression,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): ScalarType | undefined {
	return scalarDataType(inferAt(expression, ctx, errors, path, "value")?.data);
}
function inferOperand(
	operand: Expression | Term,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): ScalarType | undefined {
	return isExpression(operand)
		? inferScalar(operand, ctx, errors, path)
		: scalarDataType(inferTerm(operand, ctx, errors, path)?.data);
}
function inferCondition(
	expression: Expression,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	inferAt(expression, ctx, errors, path, "condition");
}

/**
 * How a node consumes a child's value. Core unpacks every value it reads as
 * one (`FunctionUtils.unpack`, `toNumeric`, `toString`, `toBoolean`, `toDate`),
 * which throws on more than one node (`XPathNodeset.java::unpack`). A few
 * positions read a node-set whole (`many`), a few return their argument for
 * the caller to unpack (`pass`), and `datetime-coerce` and `date-add` keep a
 * date and time's clock, or its loss (`inherit`).
 */
type ChildUse = "scalar" | "many" | "pass" | "inherit";
function childUse(
	parent: Expression,
	child: ExpressionChild,
	spec: FunctionSpec | undefined,
	jointlyAdmitted: boolean,
): ChildUse {
	const role = child.role;
	switch (parent.kind) {
		case "if":
			return role.kind === "operand" &&
				(role.slot === "then" || role.slot === "else")
				? "pass"
				: "scalar";
		case "switch":
			return (role.kind === "switch-case" && role.slot === "then") ||
				(role.kind === "operand" && role.slot === "fallback")
				? "pass"
				: "scalar";
		case "coalesce":
			// XpathCoalesceFunc.evalBody unpacks every argument but the last.
			return role.kind === "item" && role.index === parent.values.length - 1
				? "pass"
				: "scalar";
		case "concat":
			// XPathConcatFunc: one node-set argument is joined whole.
			return parent.parts.length === 1 ? "many" : "scalar";
		case "call": {
			if (role.kind !== "item") return "scalar";
			const argumentCount = parent.args.length;
			if (
				spec?.manyArguments?.(argumentCount).has(role.index) === true &&
				(spec.manyArgumentsJointly !== true || jointlyAdmitted)
			)
				return "many";
			return spec?.passThrough?.(argumentCount).has(role.index) === true
				? "pass"
				: "scalar";
		}
		// A count's node-set, a query's rows and every row predicate's own
		// content are read whole; a value list flattens its items.
		case "count":
		case "exists":
		case "missing":
		case "table-lookup":
		case "cases":
		case "table-rows":
		case "locations":
		case "project":
		case "value-list":
			return "many";
		case "datetime-coerce":
			return "inherit";
		case "date-add":
			return role.kind === "operand" && role.slot === "date"
				? "inherit"
				: "scalar";
		default:
			return "scalar";
	}
}
function manyValuesError(
	source: StructuralSource,
	path: CheckPath,
	ctx: TypingContext,
): CheckError {
	const repeat =
		source.reason === "repeat" && "form" in ctx
			? ctx.form?.fields.get(source.repeat)?.id
			: undefined;
	return {
		path,
		code: "many-values",
		reason: source.reason,
		several: source,
		message:
			source.reason === "repeat"
				? `This reads an answer from every entry of the repeat "${repeat ?? "repeat"}" where it needs one value. You can count or join the entries, or read just one of them.`
				: "This reads every case chosen in its menu where it needs one value. You can count or join them.",
	};
}
/** Apply the consumption rule to a node's recorded children: refuse a
 * structurally several-valued child in a position that reads one value, and
 * carry the several mark and a lost clock through the positions that keep them. */
function settle(
	expression: Expression,
	ctx: TypingContext,
	errors: CheckError[],
	result: NodeType | undefined,
): NodeType | undefined {
	if (expression.kind === "term") return result;
	const recorded = childTypes.get(errors);
	if (recorded === undefined || recorded.size === 0) return result;
	const children = expressionChildren(expression).flatMap((child) =>
		child.kind === "expression"
			? [{ child, type: recorded.get(pathKey(child.path)) }]
			: [],
	);
	const spec =
		expression.kind === "call"
			? FUNCTION_REGISTRY.get(expression.fn)
			: undefined;
	const jointlyAdmitted =
		spec?.manyArgumentsJointly === true &&
		expression.kind === "call" &&
		[...(spec.manyArguments?.(expression.args.length) ?? [])].every(
			(index) =>
				typeof recorded.get(pathKey(["call", "args", index]))?.data ===
				"object",
		);
	let several: StructuralSource | undefined;
	let clockLost = false;
	for (const { child, type } of children) {
		if (type === undefined) continue;
		const use = childUse(expression, child, spec, jointlyAdmitted);
		// XpathCoalesceFunc.evalBody returns the first non-empty argument, and an
		// unpacked argument is the value it held: its lost clock carries through
		// even where the argument is read as one value.
		if (use === "pass" || use === "inherit" || expression.kind === "coalesce")
			clockLost ||= type.clockLost === true;
		if (use === "pass") {
			several ??= type.several;
			continue;
		}
		if (use !== "many" && type.several !== undefined)
			errors.push(manyValuesError(type.several, child.path, ctx));
	}
	if (result === undefined)
		return several === undefined
			? clockLost
				? // A pass-through call keeps the lost clock of the value it returns.
					{ data: ANY_TYPE, held: "date", clockLost: true }
				: undefined
			: {
					data: { nodes: ANY_TYPE, cardinality: "many", structural: true },
					held: { nodes: "string" },
					several,
				};
	// A branch's own marks never pass through a position that reads one value.
	const data =
		several === undefined &&
		typeof result.data === "object" &&
		result.data.structural === true
			? {
					nodes: result.data.nodes,
					cardinality: result.data.cardinality,
					...(result.data.container === true
						? { container: true as const }
						: {}),
				}
			: result.data;
	return {
		data,
		held: result.held,
		...(result.caseIdOf === undefined ? {} : { caseIdOf: result.caseIdOf }),
		...(clockLost ? { clockLost: true as const } : {}),
		...(several === undefined ? {} : { several }),
	};
}

export function typeOf(
	expression: Expression,
	ctx: ExpressionContext,
): NodeType | undefined;
export function typeOf(
	expression: Expression,
	ctx: RecordQueryContext,
): Pick<NodeType, "data" | "caseIdOf"> | undefined;
export function typeOf(
	expression: Expression,
	ctx: TypingContext,
): NodeType | Pick<NodeType, "data" | "caseIdOf"> | undefined;
export function typeOf(
	expression: Expression,
	ctx: TypingContext,
): NodeType | Pick<NodeType, "data" | "caseIdOf"> | undefined {
	const type = infer(expression, ctx).type;
	return type === undefined || !("kind" in ctx)
		? type
		: {
				data: type.data,
				...(type.caseIdOf === undefined ? {} : { caseIdOf: type.caseIdOf }),
			};
}
export function checkExpression(
	expression: Expression,
	ctx: ExpressionContext,
): CheckOutcome {
	const expectation = ctx.profile.expectation;
	const outcome = infer(
		expression,
		ctx,
		expectation.kind === "condition" ? "condition" : "value",
	);
	const errors = [...outcome.errors];
	const slot = ctx.slot;
	if (
		slot.entity === "form" &&
		slot.slot === "form_link_datum_xpath" &&
		!ctx.targetSupplies?.refs.some(
			(supply) => datumRefKey(supply.ref) === datumRefKey(slot.member.datum),
		)
	)
		errors.push(
			refusal(
				"datum-not-supplied",
				"The destination no longer asks for this selected record.",
				"target-not-requested",
			),
		);
	if (expectation.kind === "value" && expectation.type !== undefined) {
		const data = scalarDataType(outcome.type?.data);
		if (data !== undefined && !typesCompatible(data, expectation.type))
			errors.push({
				path: [],
				code: "expected-value",
				message: `Expression resolves to '${describe(data)}', which is not compatible with expected '${expectation.type}'.`,
			});
	}
	if (
		outcome.type?.several !== undefined &&
		!(expectation.kind === "value" && expectation.many === true)
	)
		errors.push(manyValuesError(outcome.type.several, [], ctx));
	if (expectation.kind === "assignment")
		assignmentErrors(expression, ctx, expectation.destinations, errors);
	if (ctx.slot.entity === "field" && ctx.slot.slot === "default_value")
		checkChoiceDefault(expression, ctx, errors);
	return { type: outcome.type, errors };
}

/** Internal writer inference has no authored profile. It still needs the
 * record walk's errors so an invalid operation contributes no type opinion. */
export function inferRecordQuery(
	expression: Expression,
	ctx: RecordQueryContext,
	position: RecordPosition = "value",
): CheckOutcome {
	return infer(expression, ctx, position);
}

function refusal(
	code: CheckErrorCode,
	message: string,
	reason?: string,
): CheckError {
	return {
		path: [],
		code,
		message,
		...(reason === undefined ? {} : { reason }),
	};
}
function admission(
	expression: Expression,
	ctx: TypingContext,
	position?: RecordPosition,
): CheckError | undefined {
	if (!("profile" in ctx)) return undefined;
	const profile = ctx.profile;
	if (expression.kind === "call") {
		const spec = FUNCTION_REGISTRY.get(expression.fn);
		const issue =
			spec === undefined
				? `Unknown function '${expression.fn}'.`
				: functionArityIssue(expression.fn, expression.args.length, spec);
		if (issue !== undefined)
			return refusal("arm-unavailable", issue, "function-arity");
	}

	if (expression.kind === "here" && !profile.here)
		return refusal(
			"arm-unavailable",
			profile.formAnswers
				? "here() reads the worker's location, which CommCare offers only in a case list's calculated column. You can read a location question's answer instead."
				: "here() reads the worker's location, which CommCare offers only in a case list's calculated column. You can show it in a calculated column instead.",
			"here",
		);
	if (expression.kind === "choice-name") {
		// FormDef.initEvalContext's handler reads QuestionDef.getChoices, which
		// is null for a question whose choices come from an itemset.
		const choices = ctx.form?.fields.get(expression.field)?.choices;
		return choices !== undefined && choices.kind !== "inline"
			? refusal(
					"arm-unavailable",
					"This question's choices come from a lookup table or a case list, so CommCare can't read a choice's label. You can read the answer itself instead.",
					"choice-name-dynamic",
				)
			: refusal(
					"arm-unavailable",
					"A choice's label can't be read in this setting. You can read the answer itself instead.",
					"choice-name",
				);
	}
	if (
		[
			"value-list",
			"itext",
			"selected-cases",
			"table-rows",
			"locations",
		].includes(expression.kind) ||
		(expression.kind === "cases" && expression.source === "search-results") ||
		(ctx.ruleSet === "form" && expression.kind === "table-lookup")
	)
		return refusal(
			"arm-unavailable",
			"This expression is not available in this setting.",
			expression.kind,
		);
	// The form grammar has no spelling for record-only constructs.
	// Shared storage does not widen either authoring grammar.
	if (
		ctx.ruleSet === "form" &&
		([
			"date-add",
			"datetime-coerce",
			"switch",
			"in",
			"within-distance",
			"between",
			"when-input-present",
			"exists",
			"missing",
		].includes(expression.kind) ||
			(expression.kind === "arith" && expression.op === "quotient") ||
			(expression.kind === "count" && isRelationPath(expression.via)) ||
			(expression.kind === "match" && expression.mode !== "starts-with") ||
			(expression.kind === "multi-select-contains" &&
				(expression.quantifier !== "any" || expression.values.length !== 1)))
	)
		return refusal(
			"arm-unavailable",
			"This record expression has no form expression spelling.",
			expression.kind,
		);
	if (ctx.ruleSet === "record") {
		if (
			["call", "cases", "table-rows", "locations", "project"].includes(
				expression.kind,
			) ||
			(expression.kind === "count" && !isRelationPath(expression.via))
		)
			return refusal(
				"arm-unavailable",
				"This expression is not available in a record rule.",
				expression.kind,
			);
		if (
			(expression.kind === "if" || expression.kind === "switch") &&
			position === "condition"
		)
			return refusal(
				"arm-unavailable",
				"A conditional expression is not available as this record condition.",
				expression.kind,
			);
		if (
			expression.kind === "matches-pattern" &&
			typeof expression.pattern === "string" &&
			(expression.pattern.length === 0 || expression.pattern.length > 1000)
		)
			return refusal(
				"arm-unavailable",
				"A record pattern needs between 1 and 1000 characters.",
				"record-pattern-length",
			);
		if (
			expression.kind === "format-date" &&
			typeof expression.pattern === "string" &&
			(expression.pattern.length === 0 ||
				!COMMCARE_DATE_PATTERN_REGEX.test(expression.pattern))
		)
			return refusal(
				"arm-unavailable",
				"Choose a supported date format.",
				"record-date-pattern",
			);
	} else if (
		(expression.kind === "and" || expression.kind === "or") &&
		expression.clauses.length === 1
	)
		return refusal(
			"arm-unavailable",
			"A logical expression needs at least two clauses in form logic.",
			"logical-not-spellable",
		);
	if (
		!profile.caseData &&
		(["exists", "missing", "cases"].includes(expression.kind) ||
			(expression.kind === "count" && isRelationPath(expression.via)))
	)
		return refusal(
			"case-data-unavailable",
			"Case information is not available before a case is chosen.",
		);
	if (
		ctx.slot.entity === "form" &&
		ctx.slot.slot === "form_display_condition" &&
		["exists", "missing", "count"].includes(expression.kind)
	)
		return refusal(
			"case-data-unavailable",
			"A form menu can read only the case selected by its own menu.",
		);
	if (expression.kind === "term") return termAdmission(expression.term, ctx);
	return undefined;
}
function termAdmission(
	term: Term,
	ctx: ExpressionContext,
): CheckError | undefined {
	const profile = ctx.profile;
	if (
		ctx.ruleSet === "form" &&
		term.kind === "prop" &&
		term.via !== undefined &&
		term.via.kind !== "self"
	)
		return refusal(
			"arm-unavailable",
			"A form row property reads the current row. Follow another record through a record query.",
			"prop-relation",
		);
	if (
		ctx.ruleSet === "form" &&
		["table-column", "location-field", "location-level"].includes(term.kind)
	)
		return refusal(
			"arm-unavailable",
			"This expression is not available in form logic.",
			term.kind,
		);
	if (term.kind === "choice" && !profile.formAnswers)
		return refusal(
			"form-answer-unavailable",
			"A question's choices are available only while that form is open.",
			"choice",
		);
	if (term.kind === "choice" && !ctx.form?.fields.has(term.field))
		return refusal(
			"unknown-form-field",
			"This choice no longer belongs to a question in this form.",
		);
	if (
		term.kind === "input" &&
		!profile.searchInputs.some((input) => input.uuid === term.searchInputUuid)
	) {
		const declarations =
			ctx.form?.searchInputs ??
			(ctx.slot.entity === "module"
				? ctx.facts.moduleSearchInputs.get(ctx.slot.uuid)
				: undefined) ??
			[];
		if (declarations.some((input) => input.uuid === term.searchInputUuid))
			return refusal(
				"search-answer-unavailable",
				"This setting cannot read a Search answer.",
				"search-input",
			);
	}

	if (
		ctx.slot.entity === "field" &&
		ctx.slot.slot === "lookup_options_source"
	) {
		if (term.kind === "field") {
			const field = ctx.form?.fields.get(term.uuid);
			const owner = ctx.form?.fields.get(ctx.slot.uuid);
			if (
				field === undefined ||
				owner === undefined ||
				(field.type === undefined && field.kind !== "hidden")
			)
				return refusal(
					"form-answer-unavailable",
					"Choose an answer field in this form.",
					"field-unavailable",
				);
			if (
				field.repeats.length > owner.repeats.length ||
				field.repeats.some((uuid, index) => uuid !== owner.repeats[index])
			)
				return refusal(
					"form-answer-unavailable",
					"A choice filter can read answers from its current or enclosing repeat.",
					"field-repeat-scope",
				);
			const order = [...(ctx.form?.fields.keys() ?? [])];
			if (order.indexOf(term.uuid) >= order.indexOf(ctx.slot.uuid))
				return refusal(
					"form-answer-unavailable",
					"A choice filter can read only earlier answers in this form.",
					"field-not-earlier",
				);
		}
	}

	if (
		ctx.ruleSet === "record" &&
		((term.kind === "form-case" &&
			!(profile.scope === "case" && profile.formAnswers)) ||
			[
				"form-node",
				"repeat-row",
				"case-type",
				"case-row-type",
				"case-index",
				"location-field",
				"location-level",
			].includes(term.kind) ||
			(term.kind === "field" &&
				(term.role !== undefined ||
					term.filters !== undefined ||
					term.spelling === "current")))
	)
		return refusal(
			"arm-unavailable",
			"This form reference is not available in a record rule.",
			term.kind,
		);
	if (
		ctx.ruleSet === "form" &&
		term.kind === "literal" &&
		(typeof term.value === "boolean" ||
			term.value === null ||
			term.data_type !== undefined ||
			(typeof term.value === "string" &&
				term.value.includes("'") &&
				term.value.includes('"')))
	)
		return refusal(
			"arm-unavailable",
			"This literal has no form XPath spelling. Use the corresponding expression or join text parts.",
			"literal-not-spellable",
		);
	if (
		["field", "form-node", "repeat-row"].includes(term.kind) &&
		!profile.formAnswers
	)
		return refusal(
			"form-answer-unavailable",
			"Form answers are not available in this setting. Save the answer to the case and read it there.",
		);
	if (term.kind === "prop" && !profile.caseData)
		return refusal(
			"case-data-unavailable",
			"Case information is not available before a case is chosen.",
		);
	if (
		term.kind === "prop" &&
		ctx.slot.entity === "form" &&
		ctx.slot.slot === "form_display_condition" &&
		(term.caseType !== caseScope(ctx)?.caseType ||
			(term.via !== undefined && term.via.kind !== "self"))
	)
		return refusal(
			"case-data-unavailable",
			"A form menu can read only the case selected by its own menu.",
		);
	if (
		term.kind === "input" &&
		ctx.ruleSet === "form" &&
		!ctx.form?.noMatchesForm
	)
		return refusal(
			"search-answer-unavailable",
			"Search answers are available only in the form opened when a search found no matches.",
		);

	if (term.kind === "session-datum") {
		const datum = term.datum;
		if ("module" in term.datum && !ctx.facts.moduleUuids.has(term.datum.module))
			return refusal(
				"unknown-form-field",
				"The menu this session value names no longer exists.",
				"datum-module",
			);
		if (
			datum.kind === "new-child-case" &&
			!ctx.facts.caseTypes.some((type) => type.name === datum.caseType)
		)
			return refusal(
				"unknown-case-type",
				"The new record type this session value names no longer exists.",
				"datum-case-type",
			);
		if (ctx.ruleSet === "record")
			return refusal(
				"arm-unavailable",
				"A selected-case datum is not available in this record rule.",
				"session-datum",
			);
		if (
			!ctx.supplies.refs.some(
				(supply) =>
					supply.scalar && datumRefKey(supply.ref) === datumRefKey(term.datum),
			)
		)
			return refusal(
				"datum-not-supplied",
				"This entry has not supplied the selected session value.",
				term.datum.kind,
			);
	}
	return undefined;
}

/** A query's row type comes from its type predicate or an identity-bearing id
 * comparison. Property qualifiers never invent a query's result type. */
export function expressionRowScope(
	expression: Expression,
	ctx: ExpressionContext,
): RowScope | undefined;
export function expressionRowScope(
	expression: Expression,
	ctx: RecordQueryContext,
): RecordQueryRowScope | undefined;
export function expressionRowScope(
	expression: Expression,
	ctx: TypingContext,
): RowScope | RecordQueryRowScope | undefined;
export function expressionRowScope(
	expression: Expression,
	ctx: TypingContext,
): RowScope | RecordQueryRowScope | undefined {
	if (expression.kind === "table-rows" || expression.kind === "table-lookup") {
		const active = activeRowScope(ctx);
		const capturedCase =
			expression.kind === "table-lookup" && active?.kind === "case"
				? active
				: undefined;
		if ("kind" in ctx)
			return {
				kind: "table",
				tableId: expression.tableId,
				...(capturedCase === undefined
					? {}
					: {
							capturedCase: { kind: "case", caseType: capturedCase.caseType },
						}),
			};
		return {
			kind: "table",
			root: "table",
			tableId: expression.tableId,
			...(capturedCase === undefined ? {} : { capturedCase }),
		} as RowScope;
	}
	if (expression.kind === "locations")
		return "kind" in ctx
			? { kind: "location" }
			: { kind: "location", root: "locations" };
	if (expression.kind === "project")
		return expressionRowScope(expression.of, ctx);
	if (expression.kind !== "cases") return undefined;
	const conjuncts: Expression[] = [];
	const add = (node: Expression): void => {
		if (node.kind === "and") for (const clause of node.clauses) add(clause);
		else conjuncts.push(node);
	};
	for (const predicate of expression.where) add(predicate);
	let caseType: string | undefined;
	for (const predicate of conjuncts) {
		if (predicate.kind !== "eq") continue;
		for (const [left, right] of [
			[predicate.left, predicate.right],
			[predicate.right, predicate.left],
		]) {
			if (
				left.kind === "term" &&
				left.term.kind === "case-row-type" &&
				right.kind === "term" &&
				right.term.kind === "case-type"
			)
				caseType = right.term.caseType;
		}
	}
	if (caseType === undefined)
		for (const predicate of conjuncts) {
			if (predicate.kind !== "eq") continue;
			for (const [left, right] of [
				[predicate.left, predicate.right],
				[predicate.right, predicate.left],
			]) {
				if (
					left.kind === "term" &&
					left.term.kind === "prop" &&
					left.term.property === "case_id"
				)
					caseType ??= infer(right, ctx).type?.caseIdOf;
			}
		}
	if ("kind" in ctx)
		return { kind: "case", ...(caseType === undefined ? {} : { caseType }) };
	return {
		kind: "case",
		root: expression.source === "casedb" ? "casedb" : "results:inline",
		...(caseType === undefined ? {} : { caseType }),
	};
}

export function expressionChildContext(
	parent: Expression | Term,
	child: ExpressionChild,
	ctx: ExpressionContext,
): ExpressionContext;
export function expressionChildContext(
	parent: Expression | Term,
	child: ExpressionChild,
	ctx: RecordQueryContext,
): RecordQueryContext;
export function expressionChildContext(
	parent: Expression | Term,
	child: ExpressionChild,
	ctx: TypingContext,
): TypingContext;
export function expressionChildContext(
	parent: Expression | Term,
	child: ExpressionChild,
	ctx: TypingContext,
): TypingContext {
	if (child.role.kind === "form-step-filter" && "profile" in ctx)
		return withFormContextNode(ctx, child.role.step);
	if (
		(parent.kind === "cases" ||
			parent.kind === "table-rows" ||
			parent.kind === "locations" ||
			parent.kind === "table-lookup") &&
		child.role.kind !== "form-step-filter"
	) {
		const row = expressionRowScope(parent, ctx);
		if (row !== undefined) return rebind(ctx, row as RowScope);
	}
	if (
		parent.kind === "project" &&
		child.role.kind === "operand" &&
		child.role.slot === "value"
	) {
		const row = expressionRowScope(parent.of, ctx);
		if (row !== undefined) return rebind(ctx, row as RowScope);
	}
	if (
		(parent.kind === "exists" ||
			parent.kind === "missing" ||
			parent.kind === "count") &&
		child.role.kind === "operand" &&
		child.role.slot === "where" &&
		isRelationPath(parent.via)
	) {
		const destination = resolveRelationDestination(
			parent.via,
			caseScope(ctx)?.caseType,
			ctx.facts.caseTypes,
		);
		if (destination.ok) return withCase(ctx, destination.caseType);
	}
	return ctx;
}
export function expressionContextAtPath(
	root: Expression,
	ctx: ExpressionContext,
	path: CheckPath,
): ExpressionContext {
	const visit = (
		node: Expression | Term,
		current: ExpressionContext,
		at: CheckPath,
	): ExpressionContext => {
		for (const child of expressionChildren(node, at)) {
			if (
				child.kind === "relation" ||
				child.path.length > path.length ||
				child.path.some((part, index) => part !== path[index])
			)
				continue;
			const scoped = expressionChildContext(node, child, current);
			const branch =
				(node.kind === "if" &&
					child.role.kind === "operand" &&
					(child.role.slot === "then" || child.role.slot === "else")) ||
				(node.kind === "switch" &&
					((child.role.kind === "switch-case" && child.role.slot === "then") ||
						(child.role.kind === "operand" && child.role.slot === "fallback")));
			const condition =
				node.kind === "and" ||
				node.kind === "or" ||
				node.kind === "not" ||
				(child.role.kind === "operand" &&
					(child.role.slot === "where" ||
						child.role.slot === "cond" ||
						(node.kind === "when-input-present" &&
							child.role.slot === "clause"))) ||
				(child.role.kind === "item" && child.role.slot === "where");
			const expectation =
				branch || node.kind === "term"
					? current.profile.expectation
					: condition
						? { kind: "condition" as const }
						: { kind: "value" as const };
			const next = { ...scoped, profile: { ...scoped.profile, expectation } };
			if (child.path.length === path.length) return next;
			return visit(child.value, next, child.path);
		}
		return current;
	};
	return visit(root, ctx, []);
}

function inferNode(
	expression: Expression,
	ctx: TypingContext,
	errors: CheckError[],
	position?: RecordPosition,
): NodeType | undefined {
	if (expression.kind === "term")
		return inferTerm(expression.term, ctx, errors, []);
	if (isConditionArm(expression)) {
		if (ctx.ruleSet === "form") {
			for (const child of expressionChildren(expression)) {
				if (child.kind === "relation") continue;
				const next = expressionChildContext(expression, child, ctx);
				if (child.kind === "expression")
					inferAt(child.value, next, errors, child.path);
				else inferTerm(child.value, next, errors, child.path);
			}
			if (
				expression.kind === "eq" ||
				expression.kind === "neq" ||
				expression.kind === "gt" ||
				expression.kind === "gte" ||
				expression.kind === "lt" ||
				expression.kind === "lte"
			)
				checkFormComparison(expression, ctx, errors);
		} else checkConditionNode(expression, ctx, errors);
		return scalar("boolean");
	}
	const read = (
		value: Expression,
		path: CheckPath,
		childPosition: RecordPosition | undefined = "value",
	): NodeType | undefined => inferAt(value, ctx, errors, path, childPosition);
	const readScalar = (
		value: Expression,
		path: CheckPath,
	): ScalarType | undefined => scalarDataType(read(value, path)?.data);
	switch (expression.kind) {
		case "today":
			return scalar("date");
		case "now":
			return scalar("datetime");
		case "id-of": {
			const ids =
				"bindings" in ctx
					? ctx.bindings.operationIds
					: ctx.profile.operationIds;
			if (!ids.has(expression.opUuid)) {
				errors.push(
					refusal(
						"unknown-operation-id",
						`Create operation '${expression.opUuid}' is not available before this expression.`,
					),
				);
				return undefined;
			}
			return {
				...scalar("text"),
				...("profile" in ctx &&
				ctx.facts.operationCaseTypes.has(expression.opUuid)
					? { caseIdOf: ctx.facts.operationCaseTypes.get(expression.opUuid) }
					: {}),
			};
		}
		case "acting-user":
		case "unowned":
			if (!("profile" in ctx) || !ctx.profile.ownerValues) {
				errors.push(
					refusal(
						"operation-context-value",
						`The '${expression.kind}' value is available only in a case-owner expression.`,
					),
				);
				return undefined;
			}
			return scalar("text");
		case "arith": {
			const left = readScalar(expression.left, ["left"]);
			const right = readScalar(expression.right, ["right"]);
			// XPathArithExpr reads each operand through toNumeric, as number() does.
			const leftNumber = integerCodedSelect(expression.left, ctx)
				? "int"
				: left;
			const rightNumber = integerCodedSelect(expression.right, ctx)
				? "int"
				: right;
			for (const [value, type, side] of [
				[expression.left, left, "left"],
				[expression.right, right, "right"],
			] as const) {
				if (ctx.ruleSet === "form") numericLiteral(value, [side], errors);
				else if (type !== undefined && type !== ANY_TYPE && !isNumeric(type))
					errors.push({
						path: [side],
						code: "number-value",
						message: `arith requires numeric operands; ${side} got '${describe(type)}'.`,
					});
			}
			return left === undefined || right === undefined
				? undefined
				: scalar(
						// XPathArithExpr divides as doubles: 5 div 2 is 2.5.
						leftNumber === "int" &&
							rightNumber === "int" &&
							expression.op !== "div"
							? "int"
							: "decimal",
						"number",
					);
		}
		case "negate": {
			const type = readScalar(expression.value, ["negate", "value"]);
			if (ctx.ruleSet === "form")
				numericLiteral(expression.value, ["negate", "value"], errors);
			else if (type !== undefined && type !== ANY_TYPE && !isNumeric(type))
				errors.push({
					path: ["negate", "value"],
					code: "number-value",
					message: `Negation requires a numeric operand; got '${describe(type)}'.`,
				});
			return type === undefined
				? undefined
				: scalar(type === "int" ? "int" : "decimal", "number");
		}
		case "date-add": {
			const date = readScalar(expression.date, ["date"]);
			const quantity = readScalar(expression.quantity, ["quantity"]);
			if (
				ctx.ruleSet === "record" &&
				date !== undefined &&
				!isDateOrDatetime(date)
			)
				errors.push({
					path: ["date"],
					code: "date-value",
					message: `date-add requires a date or datetime; got '${describe(date)}'.`,
				});
			if (
				ctx.ruleSet === "record" &&
				quantity !== undefined &&
				!isNumeric(quantity)
			)
				errors.push({
					path: ["quantity"],
					code: "number-value",
					message: `date-add requires a numeric quantity (int or decimal); got '${describe(quantity)}'.`,
				});
			return date === undefined ? undefined : scalar(date);
		}
		case "date-coerce":
		case "datetime-coerce":
		case "double": {
			const inner = readScalar(expression.value, ["value"]);
			if (expression.kind === "datetime-coerce")
				datetimeLiteralPrecision(expression.value, ["value"], errors, true);
			if (
				ctx.ruleSet === "record" &&
				inner !== undefined &&
				inner !== ANY_TYPE &&
				!TEXT_SHAPED_TYPES.has(inner) &&
				!(expression.kind === "double"
					? isNumeric(inner)
					: isDateOrDatetime(inner))
			)
				errors.push({
					path: ["value"],
					code:
						expression.kind === "double"
							? "text-or-number-value"
							: "text-or-date-value",
					message:
						expression.kind === "double"
							? `double requires a text-shaped or numeric operand; got '${describe(inner)}'.`
							: `${expression.kind} requires a text-shaped or date-shaped operand (text / single_select / multi_select / date / datetime); got '${describe(inner)}'.`,
				});
			return scalar(
				expression.kind === "double"
					? "decimal"
					: expression.kind === "date-coerce"
						? "date"
						: "datetime",
			);
		}
		case "concat":
			for (const [index, part] of expression.parts.entries())
				read(part, ["parts", index]);
			return scalar("text");
		case "format-date": {
			const inner = readScalar(expression.date, ["date"]);
			if (
				ctx.ruleSet === "record" &&
				inner !== undefined &&
				!isDateOrDatetime(inner)
			)
				errors.push({
					path: ["date"],
					code: "date-value",
					message: `format-date requires a date or datetime; got '${describe(inner)}'.`,
				});
			if (typeof expression.pattern !== "string") {
				read(expression.pattern, ["pattern"]);
				// The case store compiles a format-date to SQL, which needs the
				// whole pattern when it compiles (compileExpression.ts::compileFormatDate).
				const fixed = fixedDatePattern(expression.pattern);
				if ("profile" in ctx && ctx.profile.targets.has("PG")) {
					if (fixed === undefined)
						errors.push({
							path: ["pattern"],
							code: "format-date-pattern-not-fixed",
							message:
								"This date format needs to be a fixed one of CommCare's formats here, because Nova's case store works it out before the expression runs. You can choose a fixed format.",
						});
					else if (
						fixed.length === 0 ||
						!COMMCARE_DATE_PATTERN_REGEX.test(fixed)
					)
						errors.push({
							path: ["pattern"],
							code: "format-date-pattern-not-fixed",
							message:
								"This date format isn't one of CommCare's formats, and Nova's case store needs one to work it out before the expression runs. You can choose one of CommCare's formats.",
						});
				}
			} else if (
				ctx.ruleSet === "form" &&
				["short", "long", "iso"].includes(expression.pattern)
			)
				errors.push({
					path: ["pattern"],
					code: "arm-unavailable",
					reason: "format-date-preset",
					message:
						"A form date format names the exact pattern, not a record-format preset.",
				});
			return scalar("text");
		}
		case "if": {
			read(expression.cond, ["if", "cond"], "condition");
			const then = read(expression.then, ["if", "then"], position);
			const otherwise = read(expression.else, ["if", "else"], position);
			return branchResult(
				[then, otherwise],
				ctx,
				errors,
				["if"],
				"if branches must agree on type",
			);
		}
		case "coalesce": {
			let agreed: NodeType | undefined;
			for (const [index, value] of expression.values.entries())
				agreed = branchResult(
					[agreed, read(value, ["values", index])],
					ctx,
					errors,
					["values", index],
					"coalesce values must agree on type",
				);
			return agreed ?? scalar(ANY_TYPE);
		}
		case "switch": {
			const on = readScalar(expression.on, ["switch", "on"]);
			let agreed: NodeType | undefined;
			for (const [index, branch] of expression.cases.entries()) {
				const when = scalarDataType(
					inferTerm(branch.when, ctx, errors, [
						"switch",
						"cases",
						index,
						"when",
					])?.data,
				);
				if (
					ctx.ruleSet === "record" &&
					on !== undefined &&
					when !== undefined &&
					!typesCompatible(on, when)
				)
					errors.push({
						path: ["switch", "cases", index, "when"],
						code: "incompatible-values",
						...dateDatetimeReason(on, when),
						message: `switch case 'when' literal '${describe(when)}' is not comparable with switch.on type '${describe(on)}'.`,
					});
				agreed = branchResult(
					[
						agreed,
						read(branch.then, ["switch", "cases", index, "then"], position),
					],
					ctx,
					errors,
					["switch", "cases", index, "then"],
					"switch case 'then' type must agree with the established branch type",
				);
			}
			return (
				branchResult(
					[agreed, read(expression.fallback, ["switch", "fallback"], position)],
					ctx,
					errors,
					["switch", "fallback"],
					"switch fallback type must agree with the established branch type",
				) ?? scalar(ANY_TYPE)
			);
		}
		case "count": {
			if (!isRelationPath(expression.via)) {
				read(expression.via, ["count", "via"]);
				return scalar("int");
			}
			const origin = caseScope(ctx)?.caseType;
			if (origin === undefined)
				errors.push({
					path: ["count"],
					code: "relation-origin",
					message:
						"count requires a current case-type scope; the originating scope must be set on the type-check context.",
				});
			else {
				const destination = resolveRelationDestination(
					expression.via,
					origin,
					ctx.facts.caseTypes,
				);
				if (!destination.ok)
					errors.push({
						path: ["count", "via"],
						code: destination.code,
						message: destination.message,
					});
				else if (expression.where !== undefined)
					inferCondition(
						expression.where,
						withCase(ctx, destination.caseType),
						errors,
						["count", "where"],
					);
			}
			return scalar("int");
		}
		case "table-lookup": {
			if (ctx.rows.some((row) => row.kind === "table")) {
				errors.push({
					path: ["table-lookup"],
					code: "lookup-table-scope",
					message: "A lookup-table filter cannot contain another table lookup.",
				});
				return undefined;
			}
			const columns = ctx.lookupTables.get(expression.tableId);
			if (columns === undefined) {
				errors.push({
					path: ["table-lookup", "tableId"],
					code: "unknown-lookup-table",
					message:
						"This expression reads a Project data table that is not available here. It may have been deleted, or it may belong to another Project.",
				});
				return undefined;
			}
			const type = columns.get(expression.resultColumnId);
			if (type === undefined)
				errors.push({
					path: ["table-lookup", "resultColumnId"],
					code: "unknown-lookup-column",
					message:
						"The column this lookup returns is not on the table it reads. The column may have been removed, or the lookup may point at the wrong table.",
				});
			const row = expressionRowScope(expression, ctx);
			if (row !== undefined)
				inferCondition(expression.where, rebind(ctx, row as RowScope), errors, [
					"table-lookup",
					"where",
				]);
			return type === undefined ? undefined : scalar(type, "string");
		}
		case "cases":
		case "table-rows":
		case "locations": {
			const row = expressionRowScope(expression, ctx);
			const scoped = row === undefined ? ctx : rebind(ctx, row as RowScope);
			for (const [index, where] of expression.where.entries())
				inferAt(
					where,
					scoped,
					errors,
					[expression.kind, "where", index],
					ctx.ruleSet === "record" ? "condition" : undefined,
				);
			return nodes(
				expression.kind === "cases"
					? "case"
					: expression.kind === "table-rows"
						? "table"
						: "location",
				"string",
				"many",
			);
		}
		case "project": {
			read(expression.of, ["project", "of"]);
			const row = expressionRowScope(expression.of, ctx);
			const value = inferTerm(
				expression.value,
				row === undefined ? ctx : rebind(ctx, row as RowScope),
				errors,
				["project", "value"],
			);
			if (value === undefined) return undefined;
			const data = scalarDataType(value.data);
			return data === undefined
				? value
				: nodes(
						data,
						typeof value.held === "object"
							? value.held.nodes
							: value.held === "sequence"
								? "string"
								: value.held,
						"many",
						value.caseIdOf,
					);
		}
		case "call": {
			const spec = FUNCTION_REGISTRY.get(expression.fn);
			const argumentNodes = expression.args.map((argument, index) => {
				const type = read(argument, ["call", "args", index]);
				if (spec?.paramTypes?.[index] === "number")
					numericLiteral(argument, ["call", "args", index], errors);
				return type;
			});
			if (spec?.returnsBranch === true) {
				const branches = spec.passThrough?.(expression.args.length);
				return branchResult(
					argumentNodes.filter((_, index) => branches?.has(index) === true),
					ctx,
					errors,
					["call"],
					`${expression.fn} values must agree on type`,
				);
			}
			const argumentTypes = argumentNodes.map((type, index) =>
				integerCodedSelect(expression.args[index], ctx)
					? "int"
					: scalarDataType(type?.data),
			);
			if (spec?.integral === true) return scalar("int", "number");
			if (
				spec?.integralOverIntegers === true &&
				argumentTypes.every((type) => type === "int" || type === "boolean")
			)
				return scalar("int", "number");
			if (spec?.returnType === "boolean") return scalar("boolean");
			if (spec?.returnType === "number") return scalar("decimal", "number");
			if (spec?.returnType === "sequence")
				return { data: "sequence", held: "sequence" };
			if (spec?.returnType === "nodeset")
				return nodes("text", "string", "many");
			if (spec?.returnType === "string") return scalar("text");
			return undefined;
		}
		case "selected-cases":
			// A several-case form's chosen cases are several by the module's
			// declaration, as a repeat holds several entries.
			return severalNodes(
				nodes(
					"text",
					"string",
					"many",
					"profile" in ctx
						? ctx.facts.moduleCaseTypes.get(expression.module)
						: undefined,
				),
				{ reason: "selected-cases", module: expression.module },
			);
		case "itext":
		case "choice-name":
			return scalar("text");
		case "here":
			// Formplayer's handler returns GeoPointData.getDisplayText().
			return scalar("geopoint", "string");
		case "value-list":
			for (const [index, item] of expression.items.entries())
				read(item, ["items", index]);
			return { data: "sequence", held: "sequence" };
	}
}

/**
 * A single-select question whose every inline option value is an integer's
 * text. Core reads its answer through `FunctionUtils.java::toNumeric`, whose
 * `Double.parseDouble` gives a whole Double for such text and NaN for a blank
 * answer, and `Recalculate.java::wrapData` stores a whole Double as
 * `IntegerData` and NaN as null, so the read is an `int` wherever it is read
 * as a number.
 */
function integerCodedSelect(
	expression: Expression | undefined,
	ctx: TypingContext,
): boolean {
	if (
		expression?.kind !== "term" ||
		expression.term.kind !== "field" ||
		!("profile" in ctx)
	)
		return false;
	const uuid = expression.term.uuid;
	const field = ctx.form?.fields.get(uuid);
	if (field?.kind !== "single_select") return false;
	const options =
		field.choices?.kind === "inline"
			? field.choices.options
			: field.choices === undefined
				? ctx.facts.options.get(uuid)
				: undefined;
	return (
		options !== undefined &&
		options.length > 0 &&
		options.every((option) => isIntegerText(option.value))
	);
}

/**
 * An optional `-` and then one or more digits whose value a Java `int` holds:
 * an option value, never XPath. A wider whole number is stored as `LongData`
 * (`Recalculate.java::wrapData`), which an integer question's
 * `IntegerData.cast` reads through `Integer.parseInt` and refuses.
 */
function isIntegerText(value: string): boolean {
	const negative = value.startsWith("-");
	const digits = negative ? value.slice(1) : value;
	if (digits.length === 0) return false;
	for (const character of digits)
		if (character < "0" || character > "9") return false;
	let start = 0;
	while (start < digits.length - 1 && digits[start] === "0") start += 1;
	const magnitude = digits.slice(start);
	const limit = negative ? "2147483648" : "2147483647";
	return (
		magnitude.length < limit.length ||
		(magnitude.length === limit.length && magnitude <= limit)
	);
}

function branchResult(
	types: readonly (NodeType | undefined)[],
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
	message: string,
): NodeType | undefined {
	let result: NodeType | undefined;
	for (const type of types) {
		if (type === undefined) continue;
		// An unknown branch (null, or a Hidden Value nothing types yet) holds
		// no opinion of the result's type.
		if (scalarDataType(type.data) === ANY_TYPE && result !== undefined)
			continue;
		if (result === undefined || scalarDataType(result.data) === ANY_TYPE) {
			result = type;
			continue;
		}
		const a = scalarDataType(result.data),
			b = scalarDataType(type.data);
		if (ctx.ruleSet === "record" && a !== undefined && b !== undefined)
			accumulateBranchType(a, b, errors, path, message);
		if (ctx.ruleSet !== "form") continue;
		// Branches agree on the value they give, whether a node-set read or a
		// scalar gives it: `coalesce(#case/visits, 0)` is an `int`. An `int`
		// and a `decimal` agree on `decimal`.
		if (a === undefined || b === undefined) {
			if (JSON.stringify(result.data) !== JSON.stringify(type.data))
				return undefined;
		} else if (a !== b) {
			if (!isNumeric(a) || !isNumeric(b)) return undefined;
			if (b === "decimal") result = type;
		}
	}
	return result;
}
function numericLiteral(
	expression: Expression,
	path: CheckPath,
	errors: CheckError[],
): void {
	if (
		expression.kind !== "term" ||
		expression.term.kind !== "literal" ||
		typeof expression.term.value !== "string" ||
		// A typed literal states its own kind; form logic refuses it as a
		// literal it can't spell, not as text that isn't a number.
		expression.term.data_type !== undefined ||
		expression.term.value.trim() === ""
	)
		return;
	if (Number.isNaN(Number(expression.term.value)))
		errors.push({
			path,
			code: "number-value",
			message: `The text '${expression.term.value}' cannot be used as a number.`,
		});
}

function checkConditionNode(
	expression: Extract<
		Expression,
		{ kind: import("./types").ConditionArm["kind"] }
	>,
	ctx: TypingContext,
	errors: CheckError[],
): void {
	switch (expression.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			checkComparison(
				expression.kind,
				expression.left,
				expression.right,
				ctx,
				errors,
				[],
			);
			return;
		case "and":
		case "or":
			for (const [index, clause] of expression.clauses.entries())
				inferCondition(clause, ctx, errors, [expression.kind, index]);
			return;
		case "not":
			inferCondition(expression.clause, ctx, errors, ["not", "clause"]);
			return;
		case "when-input-present":
			inferOperand(expression.input, ctx, errors, [
				"when-input-present",
				"input",
			]);
			inferCondition(expression.clause, ctx, errors, [
				"when-input-present",
				"clause",
			]);
			return;
		case "in":
			checkIn(expression, ctx, errors, []);
			return;
		case "within-distance":
			checkWithinDistance(expression, ctx, errors, []);
			return;
		case "match":
			checkMatch(expression, ctx, errors, []);
			return;
		case "multi-select-contains":
			checkMultiSelectContains(expression, ctx, errors, []);
			return;
		case "matches-pattern":
			checkPatternMatch(expression, ctx, errors, []);
			return;
		case "between":
			checkBetween(expression, ctx, errors, []);
			return;
		case "is-blank":
			inferScalar(expression.left, ctx, errors, ["left"]);
			return;
		case "match-all":
		case "match-none":
			return;
		case "exists":
		case "missing": {
			const origin = caseScope(ctx)?.caseType;
			if (origin === undefined) {
				errors.push(
					refusal(
						"relation-origin",
						`'${expression.kind}' requires an originating case type to anchor the relation walk; supply 'currentCaseType' on the type-checker context.`,
					),
				);
				return;
			}
			if (expression.via.kind === "self") {
				errors.push(
					refusal(
						"relation-self",
						`'${expression.kind}' with 'via: self' is meaningless: every case has itself, so the predicate is identically true. Use 'self' inside a 'where' clause to express "no further traversal."`,
					),
				);
				return;
			}
			const destination = resolveRelationDestination(
				expression.via,
				origin,
				ctx.facts.caseTypes,
			);
			if (!destination.ok) {
				errors.push({
					path: [],
					code: destination.code,
					message: destination.message,
				});
				return;
			}
			if (expression.where !== undefined)
				inferCondition(
					expression.where,
					withCase(ctx, destination.caseType),
					errors,
					[expression.kind, "where"],
				);
		}
	}
}

function inferTerm(
	term: Term,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): NodeType | undefined {
	if ("profile" in ctx) {
		const unavailable = termAdmission(term, ctx);
		if (unavailable !== undefined) {
			errors.push({ ...unavailable, path });
			return undefined;
		}
	}
	const fail = (
		code: CheckErrorCode,
		message: string,
		reason?: string,
	): undefined => {
		errors.push({ ...refusal(code, message, reason), path });
		return undefined;
	};
	switch (term.kind) {
		case "literal":
			if (
				term.data_type === "datetime" &&
				typeof term.value === "string" &&
				(literalShape(term.value)?.fractionDigits ?? 0) > 3
			)
				errors.push(datetimePrecisionError(path));
			return scalar(
				literalType(term),
				typeof term.value === "number" ? "number" : "string",
			);
		case "choice": {
			if (!("profile" in ctx)) return scalar("text");
			const structuralChoices = ctx.form?.fields.get(term.field)?.choices;
			const options =
				structuralChoices?.kind === "inline"
					? structuralChoices.options
					: ctx.facts.options.get(term.field);
			if (
				options === undefined ||
				term.options.some(
					(uuid) => !options.some((option) => option.uuid === uuid),
				)
			)
				return fail(
					"unknown-form-field",
					"This choice no longer belongs to the question it names.",
				);
			const kind = ctx.form?.fields.get(term.field)?.kind;
			return scalar(
				kind === "multi_select"
					? "multi_select"
					: kind === "single_select"
						? "single_select"
						: "text",
				"string",
			);
		}
		case "form-case": {
			if (
				!("form" in ctx) ||
				!ctx.form?.readableCaseTypes.get(term.caseType)?.has(term.property)
			)
				return fail(
					"property-scope",
					`Form record '${term.caseType}' is not available in this scope.`,
				);
			return propertyType(term.caseType, term.property, ctx, fail, "casedb");
		}
		case "prop": {
			const row = caseScope(ctx);
			if (row === undefined && ctx.ruleSet === "form")
				return fail(
					"row-scope",
					"A record property needs a record row in scope.",
					"case",
				);
			if (
				row?.caseType !== undefined &&
				term.caseType !== undefined &&
				term.caseType !== row.caseType
			)
				return fail(
					"property-scope",
					`Property reference originating scope '${term.caseType}' must equal the current scope '${row.caseType}'.`,
				);
			const origin = term.caseType ?? row?.caseType;
			const destination = resolveRelationDestination(
				term.via,
				origin,
				ctx.facts.caseTypes,
			);
			if (!destination.ok) {
				if (
					origin === undefined &&
					(term.via === undefined || term.via.kind === "self")
				) {
					const type = Object.hasOwn(
						STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
						term.property,
					)
						? STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[
								term.property as keyof typeof STANDARD_CASE_LIST_PROPERTY_DATA_TYPES
							]
						: undefined;
					return type === undefined
						? fail(
								"unknown-property",
								`Property '${term.property}' needs a known record type.`,
							)
						: nodes(
								type,
								term.property === "date_opened" ||
									term.property === "last_modified"
									? "date"
									: "string",
							);
				}
				return fail(destination.code, destination.message);
			}
			return propertyType(
				destination.caseType,
				term.property,
				ctx,
				fail,
				row !== undefined && "root" in row ? row.root : undefined,
			);
		}
		case "input": {
			const inputs =
				"bindings" in ctx ? ctx.bindings.knownInputs : ctx.profile.searchInputs;
			const input = inputs.find(
				(candidate) => candidate.uuid === term.searchInputUuid,
			);
			return input === undefined
				? fail(
						"unknown-search-input",
						"This rule reads a Search field that is no longer on this case list. Pick a field that still exists, or remove the rule.",
					)
				: nodes(input.data_type ?? "text", "string");
		}
		case "session-user":
		case "session-context":
			return nodes("text", "string");
		case "session-user-property":
			return ctx.facts.userPropertySlugs.has(term.userPropertyUuid)
				? nodes("text", "string")
				: fail(
						"unknown-user-property",
						`Worker information '${term.userPropertyUuid}' is not available in this expression context.`,
					);
		case "field":
		case "form-node":
		case "repeat-row": {
			if ("bindings" in ctx) {
				if (
					term.kind !== "field" ||
					!ctx.bindings.formFieldTypes.has(term.uuid)
				)
					return fail(
						"unknown-form-field",
						`Form field '${term.kind === "field" ? term.uuid : "generated"}' is not available in this expression context.`,
					);
				return scalar(ctx.bindings.formFieldTypes.get(term.uuid) ?? "text");
			}
			const several =
				ctx.form === undefined
					? undefined
					: structuralSeveral(term, ctx, ctx.form);
			const form = ctx.form;
			const node: FormNodeRef = term.kind === "form-node" ? term.node : term;
			if (form === undefined || !formNodeGraph(form).has(node))
				return fail(
					"unknown-form-field",
					`Form field '${term.kind === "field" ? term.uuid : formNodeKey(node)}' is not available in this expression context.`,
				);
			const nodePath = formNodeGraph(form).path(node) ?? [];
			let previousStep = 0;
			for (const [index, filter] of (term.filters ?? []).entries()) {
				const step = nodePath.findIndex(
					(candidate) => formNodeKey(candidate) === formNodeKey(filter.step),
				);
				if (step <= previousStep)
					errors.push({
						...refusal(
							"unknown-form-field",
							"This filter no longer names an ordered step on its form path.",
							"form-filter-step",
						),
						path: [...path, term.kind, "filters", index],
					});
				previousStep = step;
			}
			for (const child of expressionChildren(term, path))
				if (child.kind === "expression")
					inferAt(
						child.value,
						expressionChildContext(term, child, ctx),
						errors,
						child.path,
					);
			if (term.kind === "field") {
				const field = form.fields.get(term.uuid);
				if (field === undefined) return undefined;
				if (field.kind === "repeat")
					return severalNodes(nodes("repeat", "string"), several);
				if (field.kind === "group" || field.kind === "section")
					return severalNodes(
						{
							data: { nodes: "text", cardinality: "one", container: true },
							held: { nodes: "string" },
						},
						several,
					);
				const held =
					typeof field.held === "object" || field.held === "sequence"
						? "string"
						: field.held;
				const caseIdOf =
					field.choices?.kind === "cases" ? field.choices.caseType : undefined;
				if (field.kind === "hidden") {
					// Unknown has no opinion, but its bind still decides what Core holds.
					const hidden = nodes(field.type ?? ANY_TYPE, held, "one", caseIdOf);
					return severalNodes(
						ctx.facts.clockLost.has(term.uuid)
							? { ...hidden, clockLost: true }
							: hidden,
						several,
					);
				}
				if (field.type === undefined && ctx.ruleSet === "form")
					return several === undefined
						? undefined
						: severalNodes(nodes(ANY_TYPE), several);
				return severalNodes(
					nodes(field.type ?? "text", held, "one", caseIdOf),
					several,
				);
			}
			if (term.kind === "repeat-row") {
				if (term.attribute === "index")
					return severalNodes(nodes("int", "string"), several);
				const query = form.expressionAt({
					entity: "field",
					uuid: term.repeat,
					slot: "ids_query",
				});
				const row =
					query === undefined
						? undefined
						: expressionRowScope(
								query.kind === "project" ? query.of : query,
								ctx,
							);
				return severalNodes(
					nodes(
						"text",
						"string",
						"one",
						row?.kind === "case" ? row.caseType : undefined,
					),
					several,
				);
			}
			if (
				term.node.kind === "form-root" ||
				term.node.role === "block" ||
				term.node.role === "content"
			)
				return {
					data: { nodes: "text", cardinality: "one", container: true },
					held: { nodes: "string" },
				};
			if (term.node.kind === "repeat") {
				if (term.node.role === "query-ids")
					return severalNodes(nodes("text", "string"), several);
				if (
					term.node.role === "query-count" ||
					term.node.role === "query-position"
				)
					return severalNodes(nodes("int", "number"), several);
				const expression = form.expressionAt({
					entity: "field",
					uuid: term.node.repeat,
					slot: "repeat_count",
				});
				const countType = isExpression(expression)
					? infer(expression, ctx).type
					: undefined;
				return severalNodes(
					nodes(scalarDataType(countType?.data) ?? "decimal", "number"),
					several,
				);
			}
			if (
				term.node.kind === "connect-learn" &&
				term.node.role === "time-estimate"
			)
				return nodes("int", "string");
			if (term.node.kind === "connect-assessment" && term.node.role === "score")
				return generatedCalculation(
					{
						entity: "form",
						uuid: form.formUuid,
						slot: "assessment_user_score",
					},
					ctx,
				);
			if (
				term.node.kind === "connect-delivery" &&
				(term.node.role === "entity-id" || term.node.role === "entity-name")
			)
				return generatedCalculation(
					{
						entity: "form",
						uuid: form.formUuid,
						slot:
							term.node.role === "entity-id"
								? "deliver_entity_id"
								: "deliver_entity_name",
					},
					ctx,
				);
			return nodes("text", "string");
		}
		case "table-column": {
			const row = activeRowScope(ctx);
			if (row?.kind !== "table" || row.tableId !== term.tableId)
				return fail(
					"lookup-table-scope",
					row?.kind !== "table"
						? "A lookup column is available only inside its table's filter."
						: "This rule reads a column from a different data table than the one it filters. A row rule can only read its own table's columns.",
				);
			const type = ctx.lookupTables.get(row.tableId)?.get(term.columnId);
			return type === undefined
				? fail(
						"unknown-lookup-column",
						"This rule reads a column its data table does not have. The column may have been removed, or the rule may point at the wrong table.",
					)
				: nodes(type, "string");
		}
		case "case-type":
			return ctx.facts.caseTypes.some((type) => type.name === term.caseType)
				? scalar("text")
				: fail("unknown-case-type", `Unknown case type '${term.caseType}'.`);
		case "case-row-type":
			return activeRowScope(ctx)?.kind === "case"
				? nodes("text", "string")
				: fail(
						"row-scope",
						"A record-type read needs a record row in scope.",
						"case",
					);
		case "case-index":
			return activeRowScope(ctx)?.kind === "case"
				? nodes("text", "string", "one", term.caseType)
				: fail(
						"row-scope",
						"A record relationship needs a record row in scope.",
						"case",
					);
		case "session-datum": {
			if (!("profile" in ctx)) return undefined;
			const datum = term.datum;
			const caseIdOf =
				datum.kind === "selected-case"
					? ctx.facts.moduleCaseTypes.get(datum.module)
					: datum.kind === "new-case"
						? ctx.form === undefined
							? undefined
							: ctx.facts.moduleCaseTypes.get(ctx.form.moduleUuid)
						: datum.kind === "new-child-case"
							? datum.caseType
							: datum.kind === "worker-record"
								? "commcare-user"
								: undefined;
			return nodes("text", "string", "one", caseIdOf);
		}
		case "location-level":
			return ctx.facts.organizationLevels[term.levelUuid] === undefined
				? fail("location-value", "This place level no longer exists.")
				: scalar("text");
		case "location-field":
			return activeRowScope(ctx)?.kind === "location"
				? nodes("text", "string")
				: fail(
						"row-scope",
						"Place information needs a place row in scope.",
						"location",
					);
		case "fixed-location":
			return "profile" in ctx && ctx.profile.ownerValues
				? scalar("text")
				: fail(
						"operation-context-value",
						"A fixed place is available only as the complete value of a case-owner expression.",
					);
		case "owner-location-at-level": {
			if (!("profile" in ctx) || !ctx.profile.ownerValues)
				return fail(
					"operation-context-value",
					"An owner-to-place hop is available only as the complete value of a case-owner expression.",
				);
			const levels = ctx.facts.organizationLevels;
			const destination = levels[term.levelUuid];
			if (destination === undefined)
				return fail(
					"operation-context-value",
					"This owner hop points at an organization level that no longer exists.",
				);
			if (!destination.caseFlow.ownsCases)
				return fail(
					"operation-context-value",
					`The destination level '${destination.name}' does not own cases.`,
				);
			let ancestor =
				destination.parentLevelUuid === undefined
					? undefined
					: levels[destination.parentLevelUuid];
			const seen = new Set<string>([destination.uuid]);
			while (ancestor !== undefined && !ancestor.caseFlow.ownsCases) {
				if (seen.has(ancestor.uuid)) break;
				seen.add(ancestor.uuid);
				ancestor =
					ancestor.parentLevelUuid === undefined
						? undefined
						: levels[ancestor.parentLevelUuid];
			}
			if (ancestor === undefined || !ancestor.caseFlow.ownsCases)
				return fail(
					"operation-context-value",
					`The destination level '${destination.name}' has no case-owning level above it to match against the current owner.`,
				);
			return inferTerm(
				{ kind: "prop", caseType: term.ownerCaseType, property: "owner_id" },
				ctx,
				errors,
				path,
			) === undefined
				? undefined
				: scalar("text");
		}
	}
}

/**
 * The repeat a form read crosses: one on the read's path that its context
 * node is not inside, whose step carries no filter. Core contextualizes an
 * absolute read against its context only along their common path, and only
 * where the read's own step has no predicate (`TreeReference.java::contextualize`),
 * so a crossed repeat gives one node for every entry. The context is the
 * slot's source node for `current()`, else its lexical context node; a slot
 * with neither has every repeat crossed. Any filter on the crossed step leaves
 * the count to the data.
 */
function structuralSeveral(
	term: Extract<Term, { kind: "field" | "form-node" | "repeat-row" }>,
	ctx: ExpressionContext,
	form: FormExpressionFacts,
): StructuralSource | undefined {
	const graph = formNodeGraph(form);
	const repeatsOn = (node: FormNodeRef | undefined): readonly Uuid[] =>
		node === undefined
			? []
			: (graph.path(node) ?? []).flatMap((step) =>
					step.kind === "field" &&
					step.role === undefined &&
					form.fields.get(step.uuid)?.kind === "repeat"
						? [step.uuid]
						: [],
				);
	const base =
		"spelling" in term && term.spelling === "current"
			? ctx.sourceNode
			: ctx.contextNode;
	const inside = new Set(repeatsOn(base));
	const filtered = new Set(
		(term.filters ?? []).flatMap((filter) =>
			filter.step.kind === "field" && filter.step.role === undefined
				? [filter.step.uuid]
				: [],
		),
	);
	const crossed = repeatsOn(term.kind === "form-node" ? term.node : term).find(
		(repeat) => !inside.has(repeat) && !filtered.has(repeat),
	);
	return crossed === undefined
		? undefined
		: { reason: "repeat", repeat: crossed };
}

const resolvingGenerated = new WeakMap<ExpressionContext, Set<string>>();
function generatedCalculation(
	slot: import("./types").FormExpressionSlotRef,
	ctx: ExpressionContext,
): NodeType | undefined {
	const key = `${slot.uuid}:${slot.slot}`;
	let resolving = resolvingGenerated.get(ctx);
	if (resolving === undefined) {
		resolving = new Set();
		resolvingGenerated.set(ctx, resolving);
	}
	if (resolving.has(key)) return undefined;
	const expression = ctx.form?.expressionAt(slot);
	// A document being assembled can still hold the slot's source text.
	if (!isExpression(expression)) return undefined;
	resolving.add(key);
	try {
		const type = infer(expression, ctx).type;
		const data = scalarDataType(type?.data);
		if (type === undefined || data === undefined) return undefined;
		const held =
			typeof type.held === "object"
				? type.held.nodes
				: type.held === "sequence"
					? "string"
					: type.held;
		return nodes(data, held);
	} finally {
		resolving.delete(key);
	}
}
function propertyType(
	caseType: string,
	property: string,
	ctx: TypingContext,
	fail: (code: CheckErrorCode, message: string) => undefined,
	root?: string,
): NodeType | undefined {
	const type = ctx.facts.caseTypes.find(
		(candidate) => candidate.name === caseType,
	);
	if (type === undefined)
		return fail("unknown-case-type", `Unknown case type '${caseType}'.`);
	const declared = type.properties.find(
		(candidate) => candidate.name === property,
	);
	if (declared === undefined)
		return fail(
			"unknown-property",
			`Unknown property '${property}' on case type '${caseType}'.`,
		);
	return nodes(
		declared.data_type ?? "text",
		root === "casedb" &&
			(property === "date_opened" || property === "last_modified")
			? "date"
			: "string",
		"one",
		property === "case_id" ? caseType : undefined,
	);
}
function checkChoiceDefault(
	expression: Expression,
	ctx: ExpressionContext,
	errors: CheckError[],
): void {
	if (
		ctx.slot.entity !== "field" ||
		expression.kind !== "term" ||
		expression.term.kind !== "literal" ||
		(typeof expression.term.value !== "string" &&
			typeof expression.term.value !== "number") ||
		expression.term.value === ""
	)
		return;
	const structuralChoices = ctx.form?.fields.get(ctx.slot.uuid)?.choices;
	const choices =
		structuralChoices?.kind === "inline"
			? structuralChoices.options
			: ctx.facts.options.get(ctx.slot.uuid);
	if (choices === undefined) return;
	const text =
		typeof expression.term.value === "number"
			? numericAnswerText(expression.term.value)
			: expression.term.value;
	const values =
		ctx.form?.fields.get(ctx.slot.uuid)?.kind === "multi_select"
			? selectAnswerTokens(text)
			: [text];
	if (values.some((value) => !choices.some((option) => option.value === value)))
		errors.push(
			refusal(
				"default-not-a-choice",
				"Choose one of this question's choices as its starting value.",
			),
		);
}

function assignmentErrors(
	expression: Expression,
	ctx: ExpressionContext,
	destinations: readonly CasePropertyDataType[],
	errors: CheckError[],
): void {
	const nullPath = assignmentNullLiteralPath(expression, []);
	if (nullPath !== undefined)
		errors.push({
			path: nullPath,
			code: "expected-value",
			message:
				"Null is not a portable assignment value: device wire lowers it to blank text while Nova storage evaluates SQL NULL. Use a write condition to skip the write; an explicit clear operation is not available yet.",
		});
	assignmentRepresentationErrors(expression, [], "storage", ctx, errors);
	visitAssignmentOutputs(expression, [], (output, path) => {
		const node = infer(output, ctx).type;
		if (node?.clockLost === true && destinations.includes("datetime"))
			errors.push({
				path,
				code: "expected-value",
				reason: "clock-lost",
				message:
					"This value has kept only the day of a date and time, so saving it here would record midnight instead of the moment. You can read the date and time from the question or value that first recorded it, or save it to a date property.",
			});
		const type = scalarDataType(node?.data);
		if (type === undefined || type === ANY_TYPE) return;
		const isoDateText = isIsoDateText(output);
		for (const destination of new Set(destinations))
			if (!isWriteAssignable(type, destination, isoDateText))
				errors.push({
					path,
					code: "expected-value",
					message: `Value branch resolves to '${describe(type)}', which cannot be stored as '${destination}'. Assignment compatibility follows storage representation, not comparison compatibility.`,
				});
	});
}

function checkComparison(
	kind: ComparisonKind,
	left: Expression,
	right: Expression,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	checkCaseStatusComparison(left, right, errors, path);
	const leftType = inferScalar(left, ctx, errors, [...path, "left"]);
	const rightType = inferScalar(right, ctx, errors, [...path, "right"]);
	if (leftType === undefined || rightType === undefined) return;

	if (kind !== "eq" && kind !== "neq") {
		if (leftType === "time" || rightType === "time") {
			errors.push({
				path,
				code: "time-ordering",
				message: TIME_ORDERING_MESSAGE,
			});
			return;
		}
		const leftOrdered = leftType === ANY_TYPE || ORDERED_TYPES.has(leftType);
		const rightOrdered = rightType === ANY_TYPE || ORDERED_TYPES.has(rightType);
		if (!leftOrdered || !rightOrdered) {
			errors.push({
				path,
				code: "ordered-values",
				message: `Operator '${kind}' requires ordered types (int, decimal, date, datetime); got '${describe(leftType)}' and '${describe(rightType)}'. Strings are not ordered.`,
			});
			return;
		}
	}

	if (!typesCompatible(leftType, rightType)) {
		errors.push({
			path,
			code: "incompatible-values",
			...dateDatetimeReason(leftType, rightType),
			message: `Type mismatch: '${describe(leftType)}' and '${describe(rightType)}' are not comparable.`,
		});
	}
}

/** A date against a date and time: CommCare compares a date by its day and a
 * date and time by its moment (`XPathCmpExpr.evalRaw`, `FunctionUtils.toNumeric`). */
function dateDatetimeReason(
	left: ScalarType,
	right: ScalarType,
): { readonly reason?: "date-datetime" } {
	return (left === "date" && right === "datetime") ||
		(left === "datetime" && right === "date")
		? { reason: "date-datetime" }
		: {};
}

const isKnown = (type: ScalarType | undefined): type is ScalarType =>
	type !== undefined && type !== ANY_TYPE;
/** A string literal's own type in a form comparison: its shape, where the
 * comparison orders it or the other side has a type of its own. */
function comparisonOperandType(
	operand: Expression,
	type: ScalarType | undefined,
	other: ScalarType | undefined,
	otherIsLiteral: boolean,
	ordering: boolean,
): ScalarType | undefined {
	const literal = directLiteral(operand);
	if (
		literal === undefined ||
		literal.data_type !== undefined ||
		typeof literal.value !== "string"
	)
		return type;
	const shape = literalShape(literal.value);
	if (shape === undefined) return type;
	return ordering || (isKnown(other) && !otherIsLiteral) ? shape.type : type;
}

/**
 * Both sides of a form comparison as the form rule set types them, from
 * each side's inferred type: an untyped string literal takes the type its
 * ISO date, date-and-time or `HH:MM[:SS]` shape spells where the comparison
 * orders it, or where the other side has a type of its own and is no
 * literal.
 */
export function formComparisonOperandTypes(
	expression: Extract<
		Expression,
		{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
	>,
	leftType: ScalarType | undefined,
	rightType: ScalarType | undefined,
): {
	readonly left: ScalarType | undefined;
	readonly right: ScalarType | undefined;
} {
	const ordering = expression.kind !== "eq" && expression.kind !== "neq";
	return {
		left: comparisonOperandType(
			expression.left,
			leftType,
			rightType,
			directLiteral(expression.right) !== undefined,
			ordering,
		),
		right: comparisonOperandType(
			expression.right,
			rightType,
			leftType,
			directLiteral(expression.left) !== undefined,
			ordering,
		),
	};
}

const DATE_DATETIME_MESSAGE =
	"This compares a date with a date and time. CommCare compares a date by its day and a date and time by its moment, so the two don't line up. You can wrap the date and time in date() to compare days.";
const DATETIME_ORDERING_MESSAGE =
	"This orders a date and time against a value that isn't one. CommCare can only order two dates and times by their moment. You can compare it with another date and time, or wrap it in date() to compare days.";
const BOOLEAN_COMPARISON_MESSAGE =
	"This compares a true-or-false result with another kind of value. CommCare turns that value into true or false before comparing, and anything that isn't blank or zero counts as true. You can compare the two values themselves, or use the true-or-false result on its own.";

/**
 * The form rule set's comparison refusals, one finding per comparison, in
 * order: a time ordered (Core orders by `toNumeric`, and a time is text, so
 * NaN), a date against a date and time, a date and time ordered against a
 * value that is none, a yes/no compared with an answer (`XPathEqExpr.evalRaw`
 * turns the other side through `FunctionUtils.toBoolean`: text is true when
 * it isn't empty, a number when it isn't zero or NaN),
 * then a provably non-numeric literal in an ordering.
 */
function checkFormComparison(
	expression: Extract<
		Expression,
		{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
	>,
	ctx: TypingContext,
	errors: CheckError[],
): void {
	const ordering = expression.kind !== "eq" && expression.kind !== "neq";
	const leftType = scalarDataType(infer(expression.left, ctx).type?.data);
	const rightType = scalarDataType(infer(expression.right, ctx).type?.data);
	const { left, right } = formComparisonOperandTypes(
		expression,
		leftType,
		rightType,
	);
	if (left === "datetime")
		datetimeLiteralPrecision(expression.left, ["left"], errors, true);
	if (right === "datetime")
		datetimeLiteralPrecision(expression.right, ["right"], errors, true);
	if (ordering && (left === "time" || right === "time")) {
		errors.push(refusal("time-ordering", TIME_ORDERING_MESSAGE));
		return;
	}
	// date() on the date-and-time side makes both sides dates, so the pair
	// never reaches here; date() on a side that is already a date leaves the
	// pair a date against a date and time.
	if (
		(left === "date" && right === "datetime") ||
		(left === "datetime" && right === "date")
	) {
		errors.push(
			refusal("incompatible-values", DATE_DATETIME_MESSAGE, "date-datetime"),
		);
		return;
	}
	const notDatetime = (type: ScalarType | undefined) =>
		isKnown(type) && type !== "datetime" && type !== "date";
	if (
		ordering &&
		((left === "datetime" && notDatetime(right)) ||
			(right === "datetime" && notDatetime(left)))
	) {
		errors.push(
			refusal(
				"incompatible-values",
				DATETIME_ORDERING_MESSAGE,
				"datetime-ordering",
			),
		);
		return;
	}
	// Core compares as booleans when either side is one
	// (`XPathEqExpr.java::testEquality`), turning the other through
	// `FunctionUtils.toBoolean`: a number is true when it isn't zero, which
	// is what `= 1` and `= 0` mean, while any text but blank is true.
	const notBoolean = (type: ScalarType | undefined) =>
		isKnown(type) && type !== "boolean" && !isNumeric(type);
	if (
		!ordering &&
		((left === "boolean" && notBoolean(right)) ||
			(right === "boolean" && notBoolean(left)))
	) {
		errors.push(
			refusal("incompatible-values", BOOLEAN_COMPARISON_MESSAGE, "boolean"),
		);
		return;
	}
	// A literal its shape types is a date or a date and time, not a number
	// written as text (`FunctionUtils.toNumeric` reads date text as its day).
	if (ordering) {
		if (left === leftType) numericLiteral(expression.left, ["left"], errors);
		if (right === rightType)
			numericLiteral(expression.right, ["right"], errors);
	}
}

/** A date and time names one millisecond in every target, so a literal with
 * more than three fraction digits names none of them exactly. */
function datetimeLiteralPrecision(
	expression: Expression,
	path: CheckPath,
	errors: CheckError[],
	untypedOnly: boolean,
): void {
	const literal = directLiteral(expression);
	if (
		literal === undefined ||
		typeof literal.value !== "string" ||
		(untypedOnly && literal.data_type !== undefined)
	)
		return;
	const shape = literalShape(literal.value);
	if (shape?.type === "datetime" && shape.fractionDigits > 3)
		errors.push(datetimePrecisionError(path));
}
function datetimePrecisionError(path: CheckPath): CheckError {
	return {
		path,
		code: "datetime-literal-precision",
		reason: "datetime-literal-precision",
		message:
			"CommCare compares times to the millisecond, and this time is finer than that. You can choose a time to the millisecond, second or minute.",
	};
}

const CASE_STATUS_VALUES = new Set(["open", "closed"]);

function directProperty(expression: Expression): string | undefined {
	return expression.kind === "term" &&
		(expression.term.kind === "prop" || expression.term.kind === "form-case")
		? expression.term.property
		: undefined;
}

function directLiteral(expression: Expression): Literal | undefined {
	return expression.kind === "term" && expression.term.kind === "literal"
		? expression.term
		: undefined;
}

function invalidCaseStatusLiteral(literal: Literal): boolean {
	return (
		typeof literal.value !== "string" || !CASE_STATUS_VALUES.has(literal.value)
	);
}

function checkCaseStatusComparison(
	left: Expression,
	right: Expression,
	errors: CheckError[],
	path: CheckPath,
): void {
	const candidate =
		directProperty(left) === "status"
			? { literal: directLiteral(right), slot: "right" }
			: directProperty(right) === "status"
				? { literal: directLiteral(left), slot: "left" }
				: undefined;
	if (candidate?.literal === undefined) return;
	if (!invalidCaseStatusLiteral(candidate.literal)) return;
	errors.push({
		path: [...path, candidate.slot],
		code: "case-status-value",
		message:
			"The built-in case status can only be compared with 'open' or 'closed'. Use 'open' for an active case, or declare a separate property for program-specific workflow states",
	});
}

function checkIn(
	p: Extract<Expression, { kind: "in" }>,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const leftType = inferScalar(p.left, ctx, errors, [...path, "left"]);
	if (leftType === undefined) return;
	for (let i = 0; i < p.values.length; i++) {
		const value = p.values[i];
		if (
			directProperty(p.left) === "status" &&
			value.kind === "literal" &&
			invalidCaseStatusLiteral(value)
		) {
			errors.push({
				path: [...path, "values", i],
				code: "case-status-value",
				message:
					"The built-in case status membership values can only be 'open' or 'closed'. Use 'open' for an active case, or declare a separate property for program-specific workflow states",
			});
			continue;
		}
		const valType = inferOperand(p.values[i], ctx, errors, [
			...path,
			"values",
			i,
		]);
		if (valType === undefined) continue;
		if (!typesCompatible(leftType, valType)) {
			errors.push({
				path: [...path, "values", i],
				code: "incompatible-values",
				...dateDatetimeReason(leftType, valType),
				message: `Type mismatch: literal '${describe(valType)}' is not comparable with property type '${describe(leftType)}'.`,
			});
		}
	}
}

function checkWithinDistance(
	p: Extract<Expression, { kind: "within-distance" }>,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	if (typeof p.distance !== "number")
		inferScalar(p.distance, ctx, errors, [...path, "distance"]);
	if (typeof p.unit !== "string")
		inferScalar(p.unit, ctx, errors, [...path, "unit"]);
	const propType = inferOperand(p.property, ctx, errors, [...path, "property"]);
	if (propType !== undefined && propType !== "geopoint") {
		errors.push({
			path: [...path, "property"],
			code: "location-value",
			message: `within-distance requires a geopoint property; got '${describe(propType)}'.`,
		});
	}
	const centerType = inferScalar(p.center, ctx, errors, [...path, "center"]);
	if (
		centerType !== undefined &&
		centerType !== "geopoint" &&
		centerType !== "text"
	) {
		errors.push({
			path: [...path, "center"],
			code: "location-value",
			message: `within-distance center must resolve to a geopoint or a text-encoded coordinate string; got '${describe(centerType)}'.`,
		});
	}
}

function checkMatch(
	p: Extract<Expression, { kind: "match" }>,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const propType = inferOperand(p.property, ctx, errors, [...path, "property"]);
	const allowList = MATCH_PROPERTY_TYPES_BY_MODE[p.mode];
	if (
		propType !== undefined &&
		propType !== ANY_TYPE &&
		!allowList.has(propType)
	) {
		const allowed = [...allowList].sort().join(", ");
		errors.push({
			path: [...path, "property"],
			code: "match-value",
			message: `match mode='${p.mode}' requires a property of type ${allowed}; got '${describe(propType)}'.`,
		});
	}
	if (
		p.value.kind === "term" &&
		p.value.term.kind === "literal" &&
		p.value.term.value === ""
	) {
		errors.push({
			path: [...path, "value"],
			code: "match-value-empty",
			message: `match value cannot be the empty string. Every match mode collapses an empty value to a non-match (see matchSchema JSDoc). Use is-blank(prop) for absent-or-empty.`,
		});
	}
	const valueType = inferScalar(p.value, ctx, errors, [...path, "value"]);
	if (
		valueType !== undefined &&
		valueType !== ANY_TYPE &&
		!allowList.has(valueType as CasePropertyDataType)
	) {
		const allowed = [...allowList].sort().join(", ");
		errors.push({
			path: [...path, "value"],
			code: "match-value",
			message: `match mode='${p.mode}' requires a value resolving to ${allowed}; got '${describe(valueType)}'.`,
		});
	}
}

function checkMultiSelectContains(
	p: Extract<Expression, { kind: "multi-select-contains" }>,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const propType = inferOperand(p.property, ctx, errors, [...path, "property"]);
	if (
		propType !== undefined &&
		propType !== ANY_TYPE &&
		propType !== "multi_select"
	) {
		errors.push({
			path: [...path, "property"],
			code: "multi-select-property",
			message: `multi-select-contains requires a multi_select-typed property; got '${describe(propType)}'.`,
		});
		return;
	}
	if (propType === undefined) return;
	for (let i = 0; i < p.values.length; i++) {
		const valType = inferOperand(p.values[i], ctx, errors, [
			...path,
			"values",
			i,
		]);
		if (valType === undefined) continue;
		if (!typesCompatible(propType, valType)) {
			errors.push({
				path: [...path, "values", i],
				code: "incompatible-values",
				message: `Type mismatch: literal '${describe(valType)}' is not comparable with property type '${describe(propType)}'.`,
			});
		}
	}
}

function checkPatternMatch(
	p: Extract<Expression, { kind: "matches-pattern" }>,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	if (typeof p.pattern !== "string")
		inferScalar(p.pattern, ctx, errors, [...path, "pattern"]);
	if (("profile" in ctx && ctx.profile.patternMatching) !== true) {
		errors.push({
			path,
			code: "pattern-match-unavailable",
			message:
				"Operator 'matches-pattern' can only run where the device evaluates the rule with its Java Pattern engine: a Search field's required condition or check. This setting is evaluated elsewhere (the server's search language, the case store, or a device surface without a pattern engine), so use a comparison or a text match instead.",
		});
	}
	inferScalar(p.left, ctx, errors, [...path, "left"]);
}

function checkBetween(
	p: Extract<Expression, { kind: "between" }>,
	ctx: TypingContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const leftType = inferScalar(p.left, ctx, errors, [...path, "left"]);
	if (leftType === undefined) return;
	if (leftType === "time") {
		errors.push({
			path,
			code: "time-ordering",
			message: TIME_ORDERING_MESSAGE,
		});
		return;
	}
	if (leftType !== ANY_TYPE && !ORDERED_TYPES.has(leftType)) {
		errors.push({
			path,
			code: "ordered-values",
			message: `Operator 'between' requires an ordered left operand (int, decimal, date, datetime); got '${describe(leftType)}'. Strings are not ordered.`,
		});
		return;
	}
	if (p.lower !== undefined) {
		const lowerType = inferScalar(p.lower, ctx, errors, [...path, "lower"]);
		if (lowerType !== undefined && !typesCompatible(leftType, lowerType)) {
			errors.push({
				path: [...path, "lower"],
				code: "incompatible-values",
				...dateDatetimeReason(leftType, lowerType),
				message: `Type mismatch: lower bound '${describe(lowerType)}' is not comparable with left operand type '${describe(leftType)}'.`,
			});
		}
	}
	if (p.upper !== undefined) {
		const upperType = inferScalar(p.upper, ctx, errors, [...path, "upper"]);
		if (upperType !== undefined && !typesCompatible(leftType, upperType)) {
			errors.push({
				path: [...path, "upper"],
				code: "incompatible-values",
				...dateDatetimeReason(leftType, upperType),
				message: `Type mismatch: upper bound '${describe(upperType)}' is not comparable with left operand type '${describe(leftType)}'.`,
			});
		}
	}
	const lowerLit = unwrapLiteralOperand(p.lower);
	const upperLit = unwrapLiteralOperand(p.upper);
	if (
		lowerLit !== undefined &&
		upperLit !== undefined &&
		lowerLit.value !== null &&
		upperLit.value !== null &&
		lowerLit.value > upperLit.value
	) {
		errors.push({
			path,
			code: "range-order",
			message: `Operator 'between' has lower bound '${String(lowerLit.value)}' greater than upper bound '${String(upperLit.value)}'; the interval is empty.`,
		});
	}
}

function unwrapLiteralOperand(
	expr: Expression | undefined,
): Literal | undefined {
	if (expr === undefined) return undefined;
	if (expr.kind !== "term") return undefined;
	if (expr.term.kind !== "literal") return undefined;
	return expr.term;
}

type AssignmentRepresentationContext =
	| "storage"
	| "text-normalization"
	| "scalar-coercion";

function assignmentRepresentationErrors(
	expression: Expression,
	path: CheckPath,
	consumer: AssignmentRepresentationContext,
	ctx: TypingContext,
	errors: CheckError[],
): void {
	const descend = (
		value: Expression,
		segment: readonly (string | number)[],
		nextConsumer = consumer,
	): void => {
		assignmentRepresentationErrors(
			value,
			[...path, ...segment],
			nextConsumer,
			ctx,
			errors,
		);
	};

	switch (expression.kind) {
		case "term": {
			if (
				expression.term.kind === "literal" &&
				expression.term.value === "" &&
				(expression.term.data_type === "date" ||
					expression.term.data_type === "time" ||
					expression.term.data_type === "datetime")
			) {
				errors.push({
					path,
					code: "expected-value",
					message:
						"An empty typed temporal literal is not a portable assignment value: Nova's SQL compiler turns it into NULL while the device keeps blank text. Use a write condition to skip the write.",
				});
			}
			if (
				expression.term.kind === "literal" &&
				typeof expression.term.value === "boolean" &&
				consumer !== "text-normalization"
			) {
				errors.push({
					path,
					code: "expected-value",
					message:
						"A boolean primitive is not a portable stored or coerced value: device XPath stringifies it while Nova storage preserves a boolean. Use concat(...) as the explicit text-producing boundary.",
				});
			}
			if (consumer !== "storage") {
				const localErrors: CheckError[] = [];
				const resolved = inferOperand(expression.term, ctx, localErrors, path);
				if (resolved === "multi_select") {
					errors.push({
						path,
						code: "expected-value",
						message:
							"A multi-select value cannot flow through scalar text or coercion operators: CommCare exposes a space-token string while Nova stores a JSON array. Use a future explicit join/normalization operation instead.",
					});
				}
			}
			return;
		}
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
		case "count":
			return;
		case "concat":
			for (let index = 0; index < expression.parts.length; index += 1) {
				descend(
					expression.parts[index],
					["parts", index],
					"text-normalization",
				);
			}
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "negate":
			descend(expression.value, ["value"], "scalar-coercion");
			return;
		case "format-date":
			descend(expression.date, ["date"], "scalar-coercion");
			return;
		case "date-add":
			descend(expression.date, ["date"], "scalar-coercion");
			descend(expression.quantity, ["quantity"], "scalar-coercion");
			return;
		case "arith":
			descend(expression.left, ["left"], "scalar-coercion");
			descend(expression.right, ["right"], "scalar-coercion");
			return;
		case "coalesce": {
			const branchConsumer =
				consumer === "text-normalization" ? "scalar-coercion" : consumer;
			for (let index = 0; index < expression.values.length; index += 1) {
				descend(expression.values[index], ["values", index], branchConsumer);
			}
			return;
		}
		case "if": {
			const branchConsumer =
				consumer === "text-normalization" ? "scalar-coercion" : consumer;
			descend(expression.then, ["if", "then"], branchConsumer);
			descend(expression.else, ["if", "else"], branchConsumer);
			return;
		}
		case "switch": {
			const branchConsumer =
				consumer === "text-normalization" ? "scalar-coercion" : consumer;
			for (let index = 0; index < expression.cases.length; index += 1) {
				descend(
					expression.cases[index].then,
					["switch", "cases", index, "then"],
					branchConsumer,
				);
			}
			descend(expression.fallback, ["switch", "fallback"], branchConsumer);
			return;
		}
		default: {
			return;
		}
	}
}

/** The argument positions a branch-returning call (`cond`) can give as its
 * value, in order; empty for every other expression. */
function branchArgumentIndices(expression: Expression): readonly number[] {
	if (expression.kind !== "call") return [];
	const spec = FUNCTION_REGISTRY.get(expression.fn);
	if (spec?.returnsBranch !== true) return [];
	const branches = spec.passThrough?.(expression.args.length);
	return expression.args.flatMap((_, index) =>
		branches?.has(index) === true ? [index] : [],
	);
}

/** Every value an expression can end with: each `if`, `switch` and
 * `coalesce` branch, each value a `cond` can give, or the expression itself. */
export function visitAssignmentOutputs(
	expression: Expression,
	path: CheckPath,
	visit: (output: Expression, path: CheckPath) => void,
): void {
	switch (expression.kind) {
		case "if":
			visitAssignmentOutputs(expression.then, [...path, "if", "then"], visit);
			visitAssignmentOutputs(expression.else, [...path, "if", "else"], visit);
			return;
		case "switch":
			for (let index = 0; index < expression.cases.length; index += 1) {
				visitAssignmentOutputs(
					expression.cases[index].then,
					[...path, "switch", "cases", index, "then"],
					visit,
				);
			}
			visitAssignmentOutputs(
				expression.fallback,
				[...path, "switch", "fallback"],
				visit,
			);
			return;
		case "coalesce":
			for (let index = 0; index < expression.values.length; index += 1) {
				visitAssignmentOutputs(
					expression.values[index],
					[...path, "values", index],
					visit,
				);
			}
			return;
		case "call": {
			const branches = branchArgumentIndices(expression);
			if (branches.length === 0) {
				visit(expression, path);
				return;
			}
			for (const index of branches)
				visitAssignmentOutputs(
					expression.args[index],
					[...path, "call", "args", index],
					visit,
				);
			return;
		}
		default:
			visit(expression, path);
	}
}

function assignmentNullLiteralPath(
	expression: Expression,
	path: CheckPath,
): CheckPath | undefined {
	const first = (
		values: readonly Expression[],
		segment: string,
	): CheckPath | undefined => {
		for (let index = 0; index < values.length; index += 1) {
			const found = assignmentNullLiteralPath(values[index], [
				...path,
				segment,
				index,
			]);
			if (found !== undefined) return found;
		}
		return undefined;
	};

	switch (expression.kind) {
		case "term":
			return expression.term.kind === "literal" &&
				expression.term.value === null
				? path
				: undefined;
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
		case "count":
			return undefined;
		case "concat":
			for (let index = 0; index < expression.parts.length; index += 1) {
				const part = expression.parts[index];
				if (
					part.kind === "term" &&
					part.term.kind === "literal" &&
					part.term.value === null
				) {
					continue;
				}
				const found = assignmentNullLiteralPath(part, [
					...path,
					"parts",
					index,
				]);
				if (found !== undefined) return found;
			}
			return undefined;
		case "date-add":
			return (
				assignmentNullLiteralPath(expression.date, [...path, "date"]) ??
				assignmentNullLiteralPath(expression.quantity, [...path, "quantity"])
			);
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "negate":
			return assignmentNullLiteralPath(expression.value, [...path, "value"]);
		case "arith":
			return (
				assignmentNullLiteralPath(expression.left, [...path, "left"]) ??
				assignmentNullLiteralPath(expression.right, [...path, "right"])
			);
		case "coalesce":
			return first(expression.values, "values");
		case "if":
			return (
				assignmentNullLiteralPath(expression.then, [...path, "if", "then"]) ??
				assignmentNullLiteralPath(expression.else, [...path, "if", "else"])
			);
		case "switch": {
			let branch: CheckPath | undefined;
			for (let index = 0; index < expression.cases.length; index += 1) {
				branch = assignmentNullLiteralPath(expression.cases[index].then, [
					...path,
					"switch",
					"cases",
					index,
					"then",
				]);
				if (branch !== undefined) break;
			}
			return (
				branch ??
				assignmentNullLiteralPath(expression.fallback, [
					...path,
					"switch",
					"fallback",
				])
			);
		}
		case "format-date":
			return assignmentNullLiteralPath(expression.date, [...path, "date"]);
		default: {
			return undefined;
		}
	}
}
