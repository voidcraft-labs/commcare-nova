import { expressionChildren } from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { printFormExpression } from "@/lib/domain/expression/print";
import { type ExpressionSpans, spanKey } from "@/lib/domain/expression/spans";
import {
	CALL_FUNCTIONS,
	type CallFunction,
	type CheckPath,
	type Expression,
	type Term,
} from "@/lib/domain/expression/types";
import {
	FUNCTION_REGISTRY,
	functionArityIssue,
} from "@/lib/domain/expressionFunctions";
import { organizationLevelsOf } from "@/lib/domain/organization";
import { itextIdFor, itextUnitForId } from "../xform/itextIds";
import { formNodeProjection } from "./formNodeProjection";
import {
	type FormParseIssue,
	FormParseRefusal,
	refuse,
} from "./formParseIssues";
import type { FormParseScope } from "./formParseScope";
import { bindFormPath, type FormPathBinder } from "./formPathBinding";
import { formPrintContext, formScopeContext } from "./formPrintContext";
import {
	type FormSyntax,
	formSyntaxKey,
	matchFormSyntax,
	readFormSyntax,
} from "./formSyntax";
import { formUserProperty } from "./referenceBindings";

export type { FormParseIssue, FormParseIssueCode } from "./formParseIssues";
export type { FormParseScope, ResolveFieldPath } from "./formParseScope";
export type FormParseResult =
	| {
			readonly ok: true;
			readonly expression: Expression | undefined;
			readonly spans: ExpressionSpans;
	  }
	| { readonly ok: false; readonly issues: readonly FormParseIssue[] };

type Bounds = { readonly from: number; readonly to: number };
const comparisons = {
	"=": "eq",
	"!=": "neq",
	">": "gt",
	">=": "gte",
	"<": "lt",
	"<=": "lte",
} as const;
const arithmetic = new Set(["+", "-", "*", "div", "mod"]);

/** Parse source into identities and structured operators. No source text,
 * unresolved names or grouping trivia can enter the returned tree. */
export function parseFormExpression(
	source: string,
	scope: FormParseScope,
): FormParseResult {
	let syntax: ReturnType<typeof readFormSyntax>;
	try {
		syntax = readFormSyntax(source);
	} catch {
		return {
			ok: false,
			issues: [
				{
					code: "syntax",
					from: 0,
					to: source.length,
					message:
						"This expression can't be read. A bracket, a quote or an operator may be missing.",
				},
			],
		};
	}
	if (!syntax.ok)
		return {
			ok: false,
			issues: syntax.issues.map((issue) => ({ code: "syntax", ...issue })),
		};
	if (syntax.node === undefined)
		return { ok: true, expression: undefined, spans: new Map() };
	const rootNode = syntax.node;
	const context = formScopeContext(scope);
	if (context === undefined)
		return {
			ok: false,
			issues: [
				{
					code: "relative-no-context",
					from: 0,
					to: source.length,
					message:
						"This expression's question or form is no longer available. You can reopen it and try again.",
				},
			],
		};
	const positions = new WeakMap<object, Bounds>();
	const hints = new Map<object, Expression | Term>();
	const printed =
		scope.current === undefined
			? undefined
			: printFormExpression(
					scope.current,
					formPrintContext({
						...scope,
						form: undefined,
						sourceProjection: undefined,
					}),
				);
	if (
		scope.current !== undefined &&
		printed !== undefined &&
		printed.unresolved.length === 0
	) {
		const before = readFormSyntax(printed.text);
		if (before.ok && before.node !== undefined) {
			const byBounds = new Map<string, Expression | Term>();
			const collect = (node: Expression | Term, path: CheckPath): void => {
				const span = printed.spans.get(spanKey(path));
				if (span !== undefined)
					byBounds.set(
						`${span.from}:${span.to}`,
						node.kind === "term" ? node.term : node,
					);
				for (const child of expressionChildren(node, path))
					if (child.kind !== "relation") collect(child.value, child.path);
			};
			collect(scope.current, []);
			matchFormSyntax(before.node, syntax.node, (oldNode, newNode) => {
				if (formSyntaxKey(oldNode) !== formSyntaxKey(newNode)) return;
				const hint = byBounds.get(`${oldNode.from}:${oldNode.to}`);
				if (hint !== undefined) hints.set(newNode, hint);
			});
		}
	}
	const remember = <T extends Expression | Term>(value: T, node: Bounds): T => {
		positions.set(value, node);
		return value;
	};
	const term = (value: Term, node: Bounds): Expression =>
		remember({ kind: "term", term: remember(value, node) }, node);
	const literal = (value: string | number, node: Bounds): Expression =>
		term({ kind: "literal", value }, node);
	const expressionTerm = (value: Expression): Term | undefined =>
		value.kind === "term" ? value.term : undefined;
	function bindMany(
		nodes: readonly FormSyntax[],
		ctx: ExpressionContext,
	): Expression[] {
		const results: Expression[] = [];
		const issues: FormParseIssue[] = [];
		for (const node of nodes) {
			try {
				results.push(bind(node, ctx));
			} catch (error) {
				if (!(error instanceof FormParseRefusal)) throw error;
				issues.push(...error.issues);
			}
		}
		if (issues.length > 0) throw new FormParseRefusal(issues);
		return results;
	}
	function choiceFor(
		value: Expression,
		opposite: Expression,
		ctx: ExpressionContext,
	): Expression {
		if (
			value.kind !== "term" ||
			value.term.kind !== "literal" ||
			typeof value.term.value !== "string"
		)
			return value;
		const other = expressionTerm(opposite);
		const bounds = positions.get(value) ?? rootNode;
		if (other?.kind === "case-row-type")
			return term({ kind: "case-type", caseType: value.term.value }, bounds);
		if (other?.kind === "location-field" && other.field === "type") {
			const code = value.term.value;
			const levels = Object.values(organizationLevelsOf(scope.doc)).filter(
				(level) => level.code === code,
			);
			if (levels.length !== 1)
				refuse(
					"unknown-level",
					bounds,
					`There's no organization level with the code ${value.term.value}. You can check the level codes in App setup, Organization.`,
				);
			return term(
				{ kind: "location-level", levelUuid: levels[0].uuid },
				bounds,
			);
		}
		if (other?.kind !== "field" || other.role !== undefined) return value;
		const field = ctx.form?.fields.get(other.uuid);
		if (field?.choices?.kind !== "inline") return value;
		const prior = hints.get(bounds);
		const priorTerm = prior?.kind === "term" ? prior.term : prior;
		if (
			priorTerm?.kind === "choice" &&
			priorTerm.field === other.uuid &&
			priorTerm.options.every(
				(uuid) =>
					field.choices?.kind === "inline" &&
					field.choices.options.some((option) => option.uuid === uuid),
			)
		)
			return term(priorTerm, bounds);
		const values =
			field.kind === "multi_select"
				? value.term.value.split(/\s+/u).filter(Boolean)
				: [value.term.value];
		const options = values.map((selected) =>
			field.choices?.kind === "inline"
				? field.choices.options.find((option) => option.value === selected)
						?.uuid
				: undefined,
		);
		if (
			options.length === 0 ||
			!options.every(
				(uuid): uuid is NonNullable<typeof uuid> => uuid !== undefined,
			)
		)
			return value;
		return term(
			{
				kind: "choice",
				field: other.uuid,
				options: options as [typeof other.uuid, ...(typeof other.uuid)[]],
			},
			bounds,
		);
	}
	function hashtag(
		node: Extract<FormSyntax, { kind: "hashtag" }>,
		ctx: ExpressionContext,
	): Expression {
		if (node.namespace === "form") return bindFormPath(binder, node, ctx);
		if (node.segments.length !== 1)
			refuse(
				"unknown-hashtag",
				node,
				"This reference needs one answer path, #<record-type>/<property>, or #user/<property>.",
			);
		const property = node.segments[0];
		if (node.namespace === "user")
			return term(formUserProperty(scope, property, "worker-record"), node);
		if (node.namespace === "search") {
			const matches =
				ctx.form?.searchInputs.filter((input) => input.name === property) ?? [];
			if (matches.length !== 1)
				refuse(
					"unknown-search-input",
					node,
					`This menu's search has no field called ${property}.`,
				);
			return term({ kind: "input", searchInputUuid: matches[0].uuid }, node);
		}
		if (node.namespace === "case") {
			const selected = scope.authoring?.selectedCaseType;
			if (selected === undefined)
				refuse(
					"case-alias-unbound",
					node,
					"Name the record type with #<record-type>/<property> in this formula.",
				);
			return term({ kind: "form-case", caseType: selected, property }, node);
		}
		return term(
			{ kind: "form-case", caseType: node.namespace, property },
			node,
		);
	}
	function call(
		node: Extract<FormSyntax, { kind: "call" }>,
		ctx: ExpressionContext,
	): Expression {
		const special =
			node.name === "jr:itext"
				? { minArgs: 1, maxArgs: 1, returnType: "string" as const }
				: node.name === "jr:choice-name"
					? { minArgs: 2, maxArgs: 2, returnType: "string" as const }
					: // A case list's location handler, not a registry function:
						// a call would not carry its slot admission.
						node.name === "here"
						? { minArgs: 0, maxArgs: 0, returnType: "string" as const }
						: undefined;
		const spec = special ?? FUNCTION_REGISTRY.get(node.name);
		if (spec === undefined)
			refuse(
				"unknown-function",
				node,
				`There is no form expression function called ${node.name}(). The expressions guide lists the functions you can use.`,
			);
		const arity = functionArityIssue(node.name, node.args.length, spec);
		if (arity !== undefined) refuse("arity", node, arity);
		if (node.name === "current" || node.name === "instance")
			return bindFormPath(binder, node, ctx);
		if (node.name === "here") return remember({ kind: "here" }, node);
		if (node.name === "jr:itext") {
			const prior = hints.get(node);
			if (
				prior?.kind === "itext" &&
				itextIdFor(scope.doc, prior.unit, ctx.form) !== undefined
			)
				return remember(prior, node);
			const id = node.args[0];
			const unit =
				id.kind !== "string" || ctx.form === undefined
					? undefined
					: itextUnitForId(scope.doc, ctx.form.formUuid, id.value, ctx.form);
			if (unit === undefined)
				refuse(
					"unknown-itext",
					id,
					`This form has no translated text with that id. You can check the id against this form's translations.`,
				);
			return remember({ kind: "itext", unit }, node);
		}
		if (node.name === "jr:choice-name") {
			const pathArg = node.args[1];
			if (pathArg.kind !== "string")
				refuse(
					"choice-name-not-a-select",
					pathArg,
					"The choice label needs a select question's path in quotes, such as '#form/question'.",
				);
			const parsedPath = readFormSyntax(pathArg.value);
			if (!parsedPath.ok || parsedPath.node === undefined)
				refuse(
					"choice-name-not-a-select",
					pathArg,
					"The choice label needs a select question's path in quotes, such as '#form/question'.",
				);
			const fieldValue = bindFormPath(binder, parsedPath.node, ctx);
			const field = expressionTerm(fieldValue);
			if (
				field?.kind !== "field" ||
				!["single_select", "multi_select"].includes(
					ctx.form?.fields.get(field.uuid)?.kind ?? "",
				)
			)
				refuse(
					"choice-name-not-a-select",
					pathArg,
					"This question has no choices, so its choice label can't be read. You can show the answer itself instead.",
				);
			return remember(
				{
					kind: "choice-name",
					field: field.uuid,
					value: bind(node.args[0], ctx),
				},
				node,
			);
		}
		const args = bindMany(node.args, ctx);
		switch (node.name) {
			case "true":
				return remember({ kind: "match-all" }, node);
			case "false":
				return remember({ kind: "match-none" }, node);
			case "today":
				return remember({ kind: "today" }, node);
			case "now":
				return remember({ kind: "now" }, node);
			case "date":
				return remember({ kind: "date-coerce", value: args[0] }, node);
			case "double":
				return remember({ kind: "double", value: args[0] }, node);
			case "not":
				return remember({ kind: "not", clause: args[0] }, node);
			case "is-blank":
				return remember({ kind: "is-blank", left: args[0] }, node);
			case "concat":
				return args.length === 0
					? literal("", node)
					: remember(
							{ kind: "concat", parts: args as [Expression, ...Expression[]] },
							node,
						);
			case "coalesce":
				return remember(
					{ kind: "coalesce", values: args as [Expression, ...Expression[]] },
					node,
				);
			case "if":
				return remember(
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					{ kind: "if", cond: args[0], then: args[1], else: args[2] },
					node,
				);
			case "count":
				return remember({ kind: "count", via: args[0] }, node);
			case "starts-with":
				return remember(
					{
						kind: "match",
						property:
							args[0].kind === "term" && args[0].term.kind === "prop"
								? args[0].term
								: args[0],
						value: args[1],
						mode: "starts-with",
					},
					node,
				);
			case "regex":
				return remember(
					{
						kind: "matches-pattern",
						left: args[0],
						pattern:
							args[1].kind === "term" &&
							args[1].term.kind === "literal" &&
							typeof args[1].term.value === "string"
								? args[1].term.value
								: args[1],
					},
					node,
				);
			case "format-date": {
				const pattern = args[1];
				const scalar = expressionTerm(pattern);
				return remember(
					{
						kind: "format-date",
						date: args[0],
						pattern:
							scalar?.kind === "literal" &&
							typeof scalar.value === "string" &&
							!["short", "long", "iso"].includes(scalar.value)
								? scalar.value
								: pattern,
					},
					node,
				);
			}
			case "selected":
			case "is-selected": {
				const selected = choiceFor(args[1], args[0], ctx);
				return remember(
					{
						kind: "multi-select-contains",
						property:
							args[0].kind === "term" && args[0].term.kind === "prop"
								? args[0].term
								: args[0],
						values: [
							selected.kind === "term" &&
							(selected.term.kind === "literal" ||
								selected.term.kind === "choice")
								? selected.term
								: selected,
						],
						quantifier: "any",
					},
					node,
				);
			}
			default:
				if (!CALL_FUNCTIONS.includes(node.name as CallFunction))
					refuse(
						"unknown-function",
						node,
						`The form expression ${node.name}() isn't available here. The expressions guide lists the functions you can use.`,
					);
				return remember(
					{ kind: "call", fn: node.name as CallFunction, args },
					node,
				);
		}
	}
	function bind(node: FormSyntax, ctx: ExpressionContext): Expression {
		switch (node.kind) {
			case "group":
				return bind(node.value, ctx);
			case "number":
				if (!Number.isFinite(node.value))
					refuse(
						"syntax",
						node,
						"This number is too large to store. You can write a finite number instead.",
					);
				return literal(node.value, node);
			case "string":
				return literal(node.value, node);
			case "hashtag":
				return hashtag(node, ctx);
			case "negative": {
				const value = bind(node.value, ctx);
				return value.kind === "term" &&
					value.term.kind === "literal" &&
					typeof value.term.value === "number"
					? literal(-value.term.value, node)
					: remember({ kind: "negate", value }, node);
			}
			case "variable":
				return refuse(
					"variable",
					node,
					`Form expressions have no variables like $${node.name}. You can read the question or property that holds the value.`,
				);
			case "binary": {
				if (node.op === "|")
					refuse(
						"union",
						node,
						"Two lists can't be joined with | here. You can test each list on its own and combine the results with or.",
					);
				if (node.op === "and" || node.op === "or") {
					const parts: FormSyntax[] = [];
					const collect = (part: FormSyntax): void => {
						if (part.kind === "binary" && part.op === node.op) {
							collect(part.left);
							collect(part.right);
						} else parts.push(part);
					};
					collect(node);
					return remember(
						{
							kind: node.op,
							clauses: bindMany(parts, ctx) as [Expression, ...Expression[]],
						},
						node,
					);
				}
				const [rawLeft, rawRight] = bindMany([node.left, node.right], ctx);
				if (arithmetic.has(node.op))
					return remember(
						{
							kind: "arith",
							op: node.op as "+" | "-" | "*" | "div" | "mod",
							left: rawLeft,
							right: rawRight,
						},
						node,
					);
				const kind = comparisons[node.op as keyof typeof comparisons];
				if (kind === undefined)
					refuse(
						"syntax",
						node,
						"This expression needs a supported comparison or arithmetic operator.",
					);
				return remember(
					{
						kind,
						left: choiceFor(rawLeft, rawRight, ctx),
						right: choiceFor(rawRight, rawLeft, ctx),
					},
					node,
				);
			}
			case "call":
				return call(node, ctx);
			case "name":
			case "self":
			case "parent":
			case "root":
			case "axis":
			case "child":
			case "filter":
				return bindFormPath(binder, node, ctx);
		}
	}
	const binder: FormPathBinder = {
		scope,
		projection:
			scope.sourceProjection ??
			(context.form === undefined
				? undefined
				: formNodeProjection(scope.doc, context.form)),
		bind,
		term,
		remember,
		hint: (node) => hints.get(node),
		worker: (slug, source) => formUserProperty(scope, slug, source),
	};
	try {
		let expression = bind(syntax.node, context);
		if (scope.slot.entity === "field" && scope.slot.slot === "default_value")
			expression = choiceFor(
				expression,
				term({ kind: "field", uuid: scope.slot.uuid }, syntax.node),
				context,
			);
		const spans = new Map<string, Bounds>();
		const visit = (
			node: Expression | Term,
			path: CheckPath,
			inherited: Bounds,
		): void => {
			const bounds = positions.get(node) ?? inherited;
			spans.set(spanKey(path), bounds);
			for (const child of expressionChildren(node, path))
				if (child.kind !== "relation") visit(child.value, child.path, bounds);
		};
		visit(expression, [], syntax.node);
		return { ok: true, expression, spans };
	} catch (error) {
		if (!(error instanceof FormParseRefusal)) throw error;
		return { ok: false, issues: error.issues };
	}
}
