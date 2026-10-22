import { isDateFormatPreset, resolveCommCareDatePattern } from "../dateFormats";
import type { LookupColumnId, LookupTableId } from "../lookupIds";
import type { Uuid } from "../uuid";
import { expressionChildPath } from "./children";
import type { FormNodeGraph, FormNodeStep } from "./formNodes";
import { formatNumeric } from "./numberLiteral";
import { relativePath } from "./relativePath";
import { type ExpressionSpans, spanKey } from "./spans";
import {
	type CheckPath,
	type DatumRef,
	type Expression,
	type FormNodeRef,
	formNodeKey,
	type ItextUnit,
	isExpression,
	isRelationPath,
	type Term,
} from "./types";

export interface FormPrintContext {
	readonly graph?: FormNodeGraph;
	readonly sourceNode?: FormNodeRef;
	readonly contextNode?: FormNodeRef;
	readonly step?: (node: FormNodeRef) => FormNodeStep | undefined;
	readonly fieldPathSegments?: (uuid: Uuid) => readonly string[] | undefined;
	readonly userPropertySlug?: (uuid: Uuid) => string | undefined;
	readonly searchInputName?: (uuid: Uuid) => string | undefined;
	readonly choiceValues?: (
		field: Uuid,
		options: readonly Uuid[],
	) => readonly string[] | undefined;
	readonly datumId?: (datum: DatumRef) => string | undefined;
	readonly selectedCasesId?: (module: Uuid) => string | undefined;
	readonly tableTag?: (table: LookupTableId) => string | undefined;
	readonly tableColumnName?: (
		table: LookupTableId,
		column: LookupColumnId,
	) => string | undefined;
	readonly lookupInstancePrefix?: "" | "item-list:";
	readonly locationLevelCode?: (level: Uuid) => string | undefined;
	readonly locationPropertySlug?: (property: Uuid) => string | undefined;
	readonly itextId?: (unit: ItextUnit) => string | undefined;
}

export interface UnresolvedExpressionProjection {
	readonly path: CheckPath;
	readonly reason: "identity" | "context" | "literal" | "arm";
}
export interface FormExpressionProjection {
	readonly text: string;
	readonly spans: ExpressionSpans;
	readonly unresolved: readonly UnresolvedExpressionProjection[];
}

function precedence(node: Expression): number {
	switch (node.kind) {
		case "or":
			return 1;
		case "and":
			return 2;
		case "eq":
		case "neq":
			return 3;
		case "lt":
		case "lte":
		case "gt":
		case "gte":
			return 4;
		case "arith":
			return node.op === "+" || node.op === "-" ? 5 : 6;
		case "negate":
			return 7;
		case "term":
			return node.term.kind === "literal" &&
				typeof node.term.value === "number" &&
				node.term.value < 0
				? 7
				: 9;
		default:
			return 9;
	}
}

/** The width past which a laid-out print breaks its argument lists. */
export const LAYOUT_WIDTH = 60;
const INDENT = "    ";

export interface FormPrintOptions {
	/** Lay the text out for reading: one line when it fits within
	 * `LAYOUT_WIDTH`, else each argument list and predicate opened over
	 * indented lines, with `and` / `or` starting a line inside them. Layout
	 * adds whitespace only, which the parser discards, so a laid-out print
	 * parses to the same tree as the one-line print. */
	readonly layout?: boolean;
}

/** Human source, never an emission boundary. A missing identity stays visible
 * as repair text and a structured finding; it never becomes a guessed name. */
export function printFormExpression(
	expression: Expression,
	context: FormPrintContext = {},
	options: FormPrintOptions = {},
): FormExpressionProjection {
	const line = printWith(expression, context, false);
	return options.layout === true && line.text.length > LAYOUT_WIDTH
		? printWith(expression, context, true)
		: line;
}

function printWith(
	expression: Expression,
	context: FormPrintContext,
	broken: boolean,
): FormExpressionProjection {
	let text = "";
	let depth = 0;
	const spans = new Map<string, { from: number; to: number }>();
	const unresolved: UnresolvedExpressionProjection[] = [];
	const emit = (value: string) => {
		text += value;
	};
	const newline = () => emit(`\n${INDENT.repeat(depth)}`);
	/** The separator between two arguments. */
	const separator = () => {
		if (!broken) emit(", ");
		else {
			emit(",");
			newline();
		}
	};
	/** Arguments or a predicate between their brackets, opened over
	 * indented lines in a broken layout. */
	const bracketed = (open: string, close: string, action: () => void) => {
		emit(open);
		if (broken) {
			depth++;
			newline();
		}
		action();
		if (broken) {
			depth--;
			newline();
		}
		emit(close);
	};
	function missing(
		path: CheckPath,
		reason: UnresolvedExpressionProjection["reason"] = "identity",
	): void {
		unresolved.push({ path, reason });
		emit("[reference needs repair]");
	}
	function named(
		value: string | undefined,
		path: CheckPath,
	): string | undefined {
		if (value === undefined) {
			missing(path);
			return undefined;
		}
		return value;
	}
	function literal(
		value: string | number | boolean | null,
		path: CheckPath,
	): void {
		if (typeof value === "number" && Number.isFinite(value)) {
			emit(formatNumeric(value));
			return;
		}
		if (
			typeof value !== "string" ||
			(value.includes("'") && value.includes('"'))
		) {
			missing(path, "literal");
			return;
		}
		emit(value.includes("'") ? `"${value}"` : `'${value}'`);
	}
	function child(
		parent: Expression | Term,
		slot: string,
		value: Expression | Term,
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		const next = expressionChildPath(
			parent.kind,
			{ kind: "operand", slot },
			path,
		);
		if (isExpression(value)) write(value, next, ctx);
		else writeTerm(value, next, ctx);
	}
	function list(
		parent: Expression,
		slot: string,
		values: readonly (Expression | Term)[],
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		values.forEach((value, index) => {
			if (index > 0) separator();
			const next = expressionChildPath(
				parent.kind,
				{ kind: "item", slot, index },
				path,
			);
			if (isExpression(value)) write(value, next, ctx);
			else writeTerm(value, next, ctx);
		});
	}
	function operand(
		parent: Expression,
		slot: string,
		value: Expression,
		right: boolean,
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		const grouped =
			precedence(value) < precedence(parent) ||
			(right && precedence(value) === precedence(parent));
		if (grouped) emit("(");
		child(parent, slot, value, path, ctx);
		if (grouped) emit(")");
	}
	function filters(
		term: Extract<Term, { kind: "field" | "form-node" | "repeat-row" }>,
		node: FormNodeRef,
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		term.filters?.forEach((filter, filterIndex) => {
			if (formNodeKey(filter.step) !== formNodeKey(node)) return;
			filter.where.forEach((where, predicateIndex) => {
				bracketed("[", "]", () =>
					write(
						where,
						expressionChildPath(
							term.kind,
							{
								kind: "form-step-filter",
								step: filter.step,
								filterIndex,
								predicateIndex,
							},
							path,
						),
						{ ...ctx, contextNode: filter.step },
					),
				);
			});
		});
	}
	function formRead(
		term: Extract<Term, { kind: "field" | "form-node" | "repeat-row" }>,
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		const target: FormNodeRef =
			term.kind === "form-node"
				? term.node
				: term.kind === "field"
					? {
							kind: "field",
							uuid: term.uuid,
							...(term.role === undefined ? {} : { role: term.role }),
						}
					: {
							kind: "repeat-row",
							repeat: term.repeat,
							attribute: term.attribute,
						};
		const spelling = term.spelling;
		const graph = ctx.graph;
		if (spelling !== "relative" && spelling !== "current") {
			if (target.kind !== "field" && target.kind !== "repeat-row") {
				missing(path, "arm");
				return;
			}
			const uuid = target.kind === "field" ? target.uuid : target.repeat;
			const segments = ctx.fieldPathSegments?.(uuid);
			if (segments === undefined) {
				missing(path);
				return;
			}
			emit(spelling === "absolute" ? "/data" : "#form");
			const coordinates = graph
				?.path(target)
				?.filter((node) => node.kind === "field" && node.role === undefined);
			segments.forEach((segment, index) => {
				emit(`/${segment}`);
				const coordinate = coordinates?.[index];
				if (coordinate !== undefined) filters(term, coordinate, path, ctx);
			});
			if (target.kind === "repeat-row") {
				emit(`/@${target.attribute}`);
				filters(term, target, path, ctx);
			}
			return;
		}
		const source = spelling === "current" ? ctx.sourceNode : ctx.contextNode;
		const from = source === undefined ? undefined : graph?.path(source);
		const to = graph?.path(target);
		if (from === undefined || to === undefined || ctx.step === undefined) {
			missing(path, "context");
			return;
		}
		let firstRequiredStep: number | undefined;
		for (const filter of term.filters ?? []) {
			const index = to.findIndex(
				(node) => formNodeKey(node) === formNodeKey(filter.step),
			);
			if (index < 1) {
				missing(path);
				return;
			}
			firstRequiredStep = Math.min(firstRequiredStep ?? index, index);
		}
		const relative = relativePath(
			from,
			to,
			(a, b) => formNodeKey(a) === formNodeKey(b),
			firstRequiredStep,
		);
		const steps = relative.down.map((node) => ({
			node,
			step: ctx.step?.(node),
		}));
		if (steps.some(({ step }) => step === undefined)) {
			missing(path);
			return;
		}
		let emitted = false;
		if (spelling === "current") {
			emit("current()");
			emitted = true;
		}
		for (let index = 0; index < relative.up; index++) {
			if (emitted) emit("/");
			emit("..");
			emitted = true;
		}
		for (const { node, step } of steps) {
			if (step === undefined) continue;
			if (emitted) emit("/");
			emit(`${step.attribute ? "@" : ""}${step.name}`);
			filters(term, node, path, ctx);
			emitted = true;
		}
		if (!emitted) emit(".");
	}
	function writeTerm(term: Term, path: CheckPath, ctx: FormPrintContext): void {
		const from = text.length;
		switch (term.kind) {
			case "literal":
				if (term.data_type !== undefined) missing(path, "literal");
				else literal(term.value, path);
				break;
			case "field":
			case "form-node":
			case "repeat-row":
				formRead(term, path, ctx);
				break;
			case "prop":
				if (term.via !== undefined && term.via.kind !== "self")
					missing(path, "arm");
				else
					emit(
						["case_id", "owner_id", "status"].includes(term.property)
							? `@${term.property}`
							: term.property,
					);
				break;
			case "form-case":
				emit(`#${term.caseType}/${term.property}`);
				break;
			case "input": {
				const name = named(ctx.searchInputName?.(term.searchInputUuid), path);
				if (name !== undefined) emit(`#search/${name}`);
				break;
			}
			case "session-user":
				emit(
					term.source === "worker-record"
						? `#user/${term.field}`
						: `instance('commcaresession')/session/user/data/${term.field}`,
				);
				break;
			case "session-user-property": {
				const slug = named(ctx.userPropertySlug?.(term.userPropertyUuid), path);
				if (slug !== undefined)
					emit(
						term.source === "worker-record"
							? `#user/${slug}`
							: `instance('commcaresession')/session/user/data/${slug}`,
					);
				break;
			}
			case "session-context":
				emit(`instance('commcaresession')/session/context/${term.field}`);
				break;
			case "session-datum": {
				const id = named(ctx.datumId?.(term.datum), path);
				if (id !== undefined)
					emit(`instance('commcaresession')/session/data/${id}`);
				break;
			}
			case "table-column": {
				const name = named(
					ctx.tableColumnName?.(term.tableId, term.columnId),
					path,
				);
				if (name !== undefined) emit(name);
				break;
			}
			case "choice": {
				const values = ctx.choiceValues?.(term.field, term.options);
				if (values === undefined) missing(path);
				else literal(values.join(" "), path);
				break;
			}
			case "case-type":
				literal(term.caseType, path);
				break;
			case "case-row-type":
				emit("@case_type");
				break;
			case "case-index":
				emit(`index/${term.identifier}`);
				break;
			case "location-level": {
				const code = named(ctx.locationLevelCode?.(term.levelUuid), path);
				if (code !== undefined) literal(code, path);
				break;
			}
			case "location-field":
				if (typeof term.field === "string")
					emit(
						["id", "type"].includes(term.field) ? `@${term.field}` : term.field,
					);
				else if ("level" in term.field) {
					const code = named(ctx.locationLevelCode?.(term.field.level), path);
					if (code !== undefined) emit(`@${code}_id`);
				} else {
					const slug = named(
						ctx.locationPropertySlug?.(term.field.property),
						path,
					);
					if (slug !== undefined) emit(`location_data/${slug}`);
				}
				break;
			case "fixed-location":
			case "owner-location-at-level":
				missing(path, "arm");
				break;
		}
		spans.set(spanKey(path), { from, to: text.length });
	}
	function call(name: string, action: () => void): void {
		bracketed(`${name}(`, ")", action);
	}
	function predicates(
		node: Extract<Expression, { kind: "cases" | "table-rows" | "locations" }>,
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		node.where.forEach((where, index) => {
			bracketed("[", "]", () =>
				write(
					where,
					expressionChildPath(
						node.kind,
						{ kind: "item", slot: "where", index },
						path,
					),
					ctx,
				),
			);
		});
	}
	function tableRoot(
		table: LookupTableId,
		path: CheckPath,
		ctx: FormPrintContext,
	): boolean {
		const tag = named(ctx.tableTag?.(table), path);
		if (tag === undefined) return false;
		emit("instance(");
		literal(`${ctx.lookupInstancePrefix ?? ""}${tag}`, path);
		emit(`)/${tag}_list/${tag}`);
		return true;
	}
	function write(
		node: Expression,
		path: CheckPath,
		ctx: FormPrintContext,
	): void {
		const from = text.length;
		switch (node.kind) {
			case "term":
				writeTerm(node.term, path, ctx);
				break;
			case "eq":
			case "neq":
			case "lt":
			case "lte":
			case "gt":
			case "gte":
			case "arith": {
				if (node.kind === "arith" && node.op === "quotient") {
					missing(path, "arm");
					break;
				}
				const op =
					node.kind === "arith"
						? node.op
						: (
								{
									eq: "=",
									neq: "!=",
									lt: "<",
									lte: "<=",
									gt: ">",
									gte: ">=",
								} as const
							)[node.kind];
				operand(node, "left", node.left, false, path, ctx);
				emit(` ${op} `);
				operand(node, "right", node.right, true, path, ctx);
				break;
			}
			case "and":
			case "or":
				node.clauses.forEach((clause, index) => {
					if (index > 0 && broken && depth > 0) {
						newline();
						emit(`${node.kind} `);
					} else if (index > 0) emit(` ${node.kind} `);
					const grouped =
						precedence(clause) < precedence(node) || clause.kind === node.kind;
					if (grouped) emit("(");
					write(
						clause,
						expressionChildPath(
							node.kind,
							{ kind: "item", slot: "clauses", index },
							path,
						),
						ctx,
					);
					if (grouped) emit(")");
				});
				break;
			case "not":
				call("not", () => child(node, "clause", node.clause, path, ctx));
				break;
			case "match-all":
				emit("true()");
				break;
			case "match-none":
				emit("false()");
				break;
			case "today":
			case "now":
			case "here":
				emit(`${node.kind}()`);
				break;
			case "date-coerce":
			case "double":
				call(node.kind === "date-coerce" ? "date" : "double", () =>
					child(node, "value", node.value, path, ctx),
				);
				break;
			case "negate":
				emit("-");
				operand(node, "value", node.value, true, path, ctx);
				break;
			case "concat":
				call("concat", () => list(node, "parts", node.parts, path, ctx));
				break;
			case "coalesce":
				call("coalesce", () => list(node, "values", node.values, path, ctx));
				break;
			case "if":
				call("if", () => {
					child(node, "cond", node.cond, path, ctx);
					separator();
					child(node, "then", node.then, path, ctx);
					separator();
					child(node, "else", node.else, path, ctx);
				});
				break;
			case "count": {
				const via = node.via;
				if (isRelationPath(via)) missing(path, "arm");
				else call("count", () => child(node, "via", via, path, ctx));
				break;
			}
			case "format-date":
				call("format-date", () => {
					child(node, "date", node.date, path, ctx);
					separator();
					if (typeof node.pattern === "string") {
						if (isDateFormatPreset(node.pattern))
							unresolved.push({ path, reason: "arm" });
						literal(resolveCommCareDatePattern(node.pattern), path);
					} else child(node, "pattern", node.pattern, path, ctx);
				});
				break;
			case "is-blank":
				call("is-blank", () => child(node, "left", node.left, path, ctx));
				break;
			case "matches-pattern":
				call("regex", () => {
					child(node, "left", node.left, path, ctx);
					separator();
					if (typeof node.pattern === "string") literal(node.pattern, path);
					else child(node, "pattern", node.pattern, path, ctx);
				});
				break;
			case "match":
				if (node.mode !== "starts-with") missing(path, "arm");
				else
					call("starts-with", () => {
						child(node, "property", node.property, path, ctx);
						separator();
						child(node, "value", node.value, path, ctx);
					});
				break;
			case "multi-select-contains":
				if (node.quantifier !== "any" || node.values.length !== 1)
					missing(path, "arm");
				else
					call("selected", () => {
						child(node, "property", node.property, path, ctx);
						separator();
						list(node, "values", node.values, path, ctx);
					});
				break;
			case "call":
				if (node.args.length === 0) emit(`${node.fn}()`);
				else call(node.fn, () => list(node, "args", node.args, path, ctx));
				break;
			case "itext": {
				const id = named(ctx.itextId?.(node.unit), path);
				if (id !== undefined) call("jr:itext", () => literal(id, path));
				break;
			}
			case "choice-name": {
				const segments = ctx.fieldPathSegments?.(node.field);
				if (segments === undefined) missing(path);
				else
					call("jr:choice-name", () => {
						child(node, "value", node.value, path, ctx);
						separator();
						literal(`#form/${segments.join("/")}`, path);
					});
				break;
			}
			case "cases":
				emit(
					node.source === "casedb"
						? "instance('casedb')/casedb/case"
						: "instance('results:inline')/results/case[not(commcare_is_related_case = true())]",
				);
				predicates(node, path, ctx);
				break;
			case "table-rows":
				if (tableRoot(node.tableId, path, ctx)) predicates(node, path, ctx);
				break;
			case "locations":
				emit("instance('locations')/locations/location");
				predicates(node, path, ctx);
				break;
			case "selected-cases": {
				const id = named(ctx.selectedCasesId?.(node.module), path);
				if (id !== undefined) {
					emit("instance(");
					literal(id, path);
					emit(")/results/value");
				}
				break;
			}
			case "project":
				child(node, "of", node.of, path, ctx);
				emit("/");
				child(node, "value", node.value, path, ctx);
				break;
			case "table-lookup":
				if (tableRoot(node.tableId, path, ctx)) {
					bracketed("[", "]", () =>
						child(node, "where", node.where, path, ctx),
					);
					emit("[1]/");
					const name = named(
						ctx.tableColumnName?.(node.tableId, node.resultColumnId),
						path,
					);
					if (name !== undefined) emit(name);
				}
				break;
			case "id-of":
			case "acting-user":
			case "unowned":
			case "date-add":
			case "datetime-coerce":
			case "switch":
			case "in":
			case "within-distance":
			case "between":
			case "when-input-present":
			case "exists":
			case "missing":
			case "value-list":
				missing(path, "arm");
				break;
		}
		spans.set(spanKey(path), { from, to: text.length });
	}
	write(expression, [], context);
	return { text, spans, unresolved };
}
