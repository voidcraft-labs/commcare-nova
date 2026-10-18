/** Typed expression plans compose a separate random stream over the suite generator.
 * Resolving a plan never draws again: missing targets are the only skipped plans.
 */
import * as fc from "fast-check";
import {
	type BlueprintDoc,
	type Field,
	fieldKindCarriesValidation,
	type Uuid,
} from "@/lib/domain";
import {
	and,
	arith,
	dateLiteral,
	datetimeLiteral,
	type Expression,
	type ExpressionSlotRef,
	eq,
	formField,
	gt,
	input,
	literal,
	lt,
	neq,
	now,
	prop,
	term,
	today,
	whenInput,
} from "@/lib/domain/expression";
import {
	walkExpressionNodes,
	walkExpressionTerms,
} from "@/lib/domain/expression/walk";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

export const EXPRESSION_SHAPES = [
	"reference",
	"repeat",
	"case-query",
	"temporal",
	"number",
	"call",
	"record",
	"csql",
] as const;
export type ExpressionShape = (typeof EXPRESSION_SHAPES)[number];
const expressionPlan = fc.record({
	shape: fc.constantFrom(...EXPRESSION_SHAPES),
	slot: fc.nat(1000),
	operator: fc.integer({ min: 0, max: 11 }),
	spelling: fc.constantFrom(undefined, "absolute", "relative", "current"),
	pick: fc.nat(1000),
	other: fc.nat(1000),
});
type Plan =
	typeof expressionPlan extends fc.Arbitrary<infer Value> ? Value : never;
interface Landing {
	readonly shape: ExpressionShape;
	readonly slot: ExpressionSlotRef;
	readonly expression: Expression;
}
const landings = new WeakMap<BlueprintDoc, readonly Landing[]>();
const pick = <T>(values: readonly T[], index: number): T | undefined =>
	values[index % values.length];

function formOf(doc: BlueprintDoc, field: Uuid): Uuid | undefined {
	let at: Uuid | undefined = field;
	while (at !== undefined) {
		if (doc.forms[at]) return at;
		at = doc.fieldParent[at];
	}
	return undefined;
}
function hasRepeat(doc: BlueprintDoc, field: Uuid): boolean {
	let at = doc.fieldParent[field];
	while (at !== undefined) {
		if (doc.fields[at]?.kind === "repeat") return true;
		at = doc.fieldParent[at];
	}
	return false;
}
function read(field: Field, plan: Plan): Expression {
	return term({
		...formField(field.uuid),
		...(plan.spelling === undefined ? {} : { spelling: plan.spelling }),
	});
}
function compare(plan: Plan, left: Expression, right: Expression): Expression {
	return plan.operator % 3 === 0
		? eq(left, right)
		: plan.operator % 3 === 1
			? lt(left, right)
			: gt(left, right);
}

/** Choose a compatible existing slot after every field the value reads.
 * Every generated dependency therefore points backward in the field tree;
 * a later plan cannot close a cycle or make a container depend on its child.
 * Conditions accumulate plans; values keep the destination's scalar type.
 */
function attachForm(
	doc: BlueprintDoc,
	plan: Plan,
	form: Uuid,
	value: Expression,
	valueKind: "text" | "number" | "date" | "datetime" | "boolean",
	source?: Field,
	sameParent = false,
): Landing | undefined {
	const ordered = Object.values(doc.fields).filter(
		(field) => formOf(doc, field.uuid) === form,
	);
	let lastRead = -1;
	walkExpressionTerms(value, (leaf) => {
		if (leaf.kind === "field")
			lastRead = Math.max(
				lastRead,
				ordered.findIndex((field) => field.uuid === leaf.uuid),
			);
	});
	const fields = ordered.filter(
		(field, index) =>
			index > lastRead &&
			field.uuid !== source?.uuid &&
			(!sameParent ||
				doc.fieldParent[field.uuid] ===
					doc.fieldParent[source?.uuid ?? field.uuid]),
	);
	const condition =
		valueKind === "boolean"
			? value
			: valueKind === "number"
				? gt(value, literal(-100000))
				: eq(value, value);
	type Candidate = {
		field: Field;
		slot:
			| "relevant"
			| "validate"
			| "calculate"
			| "default_value"
			| "repeat_count";
	};
	const candidates: Candidate[] = [];
	for (const field of fields) {
		candidates.push({ field, slot: "relevant" });
		if (fieldKindCarriesValidation(field.kind))
			candidates.push({ field, slot: "validate" });
		if (field.kind === "hidden" && field.caseWrite === undefined)
			candidates.push({ field, slot: "calculate" });
		if (
			((valueKind === "text" && field.kind === "text") ||
				(valueKind === "number" && field.kind === "decimal") ||
				(valueKind === "date" && field.kind === "date") ||
				(valueKind === "datetime" && field.kind === "datetime")) &&
			field.caseWrite === undefined
		)
			candidates.push({ field, slot: "default_value" });
		if (
			valueKind === "number" &&
			source === undefined &&
			field.kind === "repeat" &&
			field.repeat_mode === "count_bound"
		)
			candidates.push({ field, slot: "repeat_count" });
	}
	const target = pick(candidates, plan.slot);
	if (!target) return undefined;
	const { field, slot } = target;
	let stored = value;
	switch (slot) {
		case "calculate":
			if (field.kind !== "hidden")
				throw new Error("A calculation target must be a Hidden Value.");
			field.calculate = value;
			delete field.default_value;
			break;
		case "repeat_count":
			if (field.kind !== "repeat" || field.repeat_mode !== "count_bound")
				throw new Error("A count target must be a counted repeat.");
			field.repeat_count = {
				kind: "call",
				fn: "int",
				args: [{ kind: "call", fn: "abs", args: [value] }],
			};
			break;
		case "default_value":
			if (
				field.kind !== "text" &&
				field.kind !== "decimal" &&
				field.kind !== "date" &&
				field.kind !== "datetime"
			)
				throw new Error("A default target must have the drawn scalar type.");
			field.default_value = value;
			break;
		case "validate":
			if (
				field.kind !== "text" &&
				field.kind !== "int" &&
				field.kind !== "decimal" &&
				field.kind !== "date" &&
				field.kind !== "datetime" &&
				field.kind !== "time" &&
				field.kind !== "barcode" &&
				field.kind !== "secret" &&
				field.kind !== "single_select" &&
				field.kind !== "multi_select"
			)
				throw new Error("A validation target must carry validation.");
			field.validate = field.validate
				? and(field.validate, condition)
				: condition;
			stored = condition;
			break;
		case "relevant":
			if (field.kind === "section") return undefined;
			field.relevant = field.relevant
				? and(field.relevant, condition)
				: condition;
			stored = condition;
	}
	return {
		shape: plan.shape,
		slot: { entity: "field", uuid: field.uuid, slot },
		expression: stored,
	};
}

function applyPlan(doc: BlueprintDoc, plan: Plan): Landing | undefined {
	const eligibleForms = (moduleId: Uuid) =>
		(doc.formOrder[moduleId] ?? []).filter((form) => {
			const fields = Object.values(doc.fields).filter(
				(field) => formOf(doc, field.uuid) === form,
			);
			if (plan.shape === "repeat")
				return fields.some(
					(field) =>
						hasRepeat(doc, field.uuid) &&
						field.kind !== "group" &&
						field.kind !== "repeat",
				);
			if (plan.shape === "temporal")
				return (
					doc.forms[form]?.type === "followup" ||
					doc.forms[form]?.type === "close" ||
					fields.some(
						(field) =>
							!hasRepeat(doc, field.uuid) &&
							(field.kind === "date" || field.kind === "datetime"),
					)
				);
			return true;
		});
	const module = pick(
		Object.values(doc.modules).filter(
			(entry) =>
				entry.caseType !== undefined && eligibleForms(entry.uuid).length > 0,
		),
		plan.pick,
	);
	if (!module?.caseType) return undefined;
	const type = module.caseType;
	const form = pick(eligibleForms(module.uuid), plan.other);
	if (form === undefined) return undefined;
	const fields = Object.values(doc.fields).filter(
		(field) => formOf(doc, field.uuid) === form,
	);
	const rootAnswers = fields.filter(
		(field) =>
			!hasRepeat(doc, field.uuid) &&
			["text", "int", "decimal", "date", "datetime"].includes(field.kind),
	);
	switch (plan.shape) {
		case "reference": {
			const field = pick(rootAnswers, plan.pick);
			if (!field) return undefined;
			const other = pick(
				rootAnswers.filter(
					(candidate) =>
						candidate.uuid !== field.uuid && candidate.kind === field.kind,
				),
				plan.other,
			);
			const right: Expression = other
				? read(other, plan)
				: field.kind === "date"
					? { kind: "date-coerce", value: term(literal("2026-01-02")) }
					: field.kind === "datetime"
						? now()
						: term(
								literal(
									field.kind === "int" || field.kind === "decimal"
										? 4
										: "sample",
								),
							);
			return attachForm(
				doc,
				plan,
				form,
				field.kind === "text"
					? eq(read(field, plan), right)
					: compare(plan, read(field, plan), right),
				"boolean",
				field,
			);
		}
		case "repeat": {
			const field = pick(
				fields.filter(
					(entry) =>
						hasRepeat(doc, entry.uuid) &&
						entry.kind !== "group" &&
						entry.kind !== "repeat",
				),
				plan.pick,
			);
			if (!field) return undefined;
			if (
				plan.operator % 2 === 0 &&
				fields.some(
					(candidate) =>
						candidate.uuid !== field.uuid &&
						doc.fieldParent[candidate.uuid] === doc.fieldParent[field.uuid],
				)
			) {
				return attachForm(
					doc,
					plan,
					form,
					eq(
						read(field, { ...plan, spelling: "relative" }),
						read(field, { ...plan, spelling: "relative" }),
					),
					"boolean",
					field,
					true,
				);
			}
			const value: Expression =
				plan.operator % 3 === 0
					? {
							kind: "call",
							fn: "join",
							args: [term(literal(" ")), term(formField(field.uuid))],
						}
					: { kind: "count", via: term(formField(field.uuid)) };
			return attachForm(
				doc,
				plan,
				form,
				value,
				value.kind === "count" ? "number" : "text",
				field,
			);
		}
		case "case-query": {
			if (
				plan.operator % 3 === 2 &&
				(doc.forms[form]?.type === "followup" ||
					doc.forms[form]?.type === "close")
			) {
				return attachForm(
					doc,
					plan,
					form,
					{
						kind: "project",
						of: {
							kind: "cases",
							source: "casedb",
							where: [
								eq(
									term(prop(type, "case_id")),
									term({
										kind: "form-case",
										caseType: type,
										property: "case_id",
									}),
								),
							],
						},
						value: prop(type, "full_name"),
					},
					"text",
				);
			}
			const typeClause = eq(
				term({ kind: "case-row-type" }),
				term({ kind: "case-type", caseType: type }),
			);
			const uniqueProperty =
				doc.caseTypes?.filter((caseType) =>
					caseType.properties.some((property) => property.name === "age"),
				).length === 1;
			const cases: Expression = {
				kind: "cases",
				source: "casedb",
				where: [
					...(plan.operator % 3 === 1 && uniqueProperty ? [] : [typeClause]),
					compare(plan, term(prop(type, "age")), term(literal(4))),
				],
			};
			return attachForm(
				doc,
				plan,
				form,
				{ kind: "count", via: cases },
				"number",
			);
		}
		case "temporal": {
			const field = pick(
				rootAnswers.filter(
					(entry) => entry.kind === "date" || entry.kind === "datetime",
				),
				plan.pick,
			);
			if (field && plan.operator % 4 === 3)
				return attachForm(
					doc,
					plan,
					form,
					{ kind: "format-date", date: read(field, plan), pattern: "%Y-%m-%d" },
					"text",
					field,
				);
			if (field)
				return attachForm(
					doc,
					plan,
					form,
					compare(
						plan,
						read(field, plan),
						field.kind === "date" ? today() : now(),
					),
					"boolean",
					field,
				);
			if (
				doc.forms[form]?.type !== "followup" &&
				doc.forms[form]?.type !== "close"
			)
				return undefined;
			return attachForm(
				doc,
				plan,
				form,
				compare(
					plan,
					term({ kind: "form-case", caseType: type, property: "last_seen" }),
					now(),
				),
				"boolean",
			);
		}
		case "number": {
			const ops = ["+", "-", "*", "div", "mod"] as const;
			let value: Expression = arith(
				ops[plan.operator % ops.length],
				term(literal((plan.pick % 7) + 1)),
				term(literal((plan.other % 3) + 1)),
			);
			if (plan.operator >= ops.length) value = { kind: "negate", value };
			return attachForm(doc, plan, form, value, "number");
		}
		case "call": {
			const field = pick(
				rootAnswers.filter((entry) => entry.kind === "text"),
				plan.pick,
			);
			if (!field) return undefined;
			const calls = [
				"string-length",
				"normalize-space",
				"contains",
				"substr",
			] as const;
			const fn = calls[plan.operator % calls.length];
			const args =
				fn === "contains"
					? [read(field, plan), term(literal("a"))]
					: fn === "substr"
						? [read(field, plan), term(literal(0)), term(literal(3))]
						: [read(field, plan)];
			return attachForm(
				doc,
				plan,
				form,
				{ kind: "call", fn, args },
				fn === "string-length"
					? "number"
					: fn === "contains"
						? "boolean"
						: "text",
				field,
			);
		}
		case "record": {
			if (!module.caseListConfig) return undefined;
			const value =
				plan.operator % 2 === 0
					? compare(
							plan,
							term(prop(type, "last_seen")),
							term(datetimeLiteral("2026-01-02T09:00:00Z")),
						)
					: compare(
							plan,
							term(prop(type, "visit_date")),
							term(dateLiteral("2026-01-02")),
						);
			module.caseListConfig.filter = module.caseListConfig.filter
				? and(module.caseListConfig.filter, value)
				: value;
			return {
				shape: plan.shape,
				slot: { entity: "module", uuid: module.uuid, slot: "case_list_filter" },
				expression: value,
			};
		}
		case "csql": {
			const target = pick(
				module.caseListConfig?.searchInputs.filter(
					(entry) => entry.kind === "advanced",
				) ?? [],
				plan.pick,
			);
			if (target?.kind !== "advanced") return undefined;
			const value = whenInput(
				input(target.uuid),
				plan.operator % 2 === 0
					? eq(term(prop(type, "phone_number")), term(input(target.uuid)))
					: neq(term(prop(type, "phone_number")), term(input(target.uuid))),
			);
			target.predicate = and(target.predicate, value);
			return {
				shape: plan.shape,
				slot: {
					entity: "module",
					uuid: module.uuid,
					slot: "search_input_predicate",
					member: { searchInputUuid: target.uuid },
				},
				expression: value,
			};
		}
	}
}

export const expressionDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.record({
		doc: suiteDocArbitrary,
		plans: fc.array(expressionPlan, { minLength: 3, maxLength: 8 }),
	})
	.map(({ doc: drawn, plans }) => {
		// A shrink may replay one drawn value: the mapper owns its copy.
		const doc = structuredClone(drawn);
		const applied: Landing[] = [];
		for (const plan of plans) {
			const landing = applyPlan(doc, plan);
			if (landing) applied.push(landing);
		}
		landings.set(doc, applied);
		return doc;
	});

/** Only shapes still present in an actual owning slot count as sample coverage. */
export function landedExpressionShapes(
	doc: BlueprintDoc,
): ReadonlySet<ExpressionShape> {
	const shapes = new Set<ExpressionShape>();
	for (const landing of landings.get(doc) ?? []) {
		const expression = expressionSlotValue(doc, landing.slot);
		if (expression)
			walkExpressionNodes(expression, (node) => {
				if (node === landing.expression) shapes.add(landing.shape);
			});
	}
	return shapes;
}
