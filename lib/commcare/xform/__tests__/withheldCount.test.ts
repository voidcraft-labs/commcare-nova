import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Expression } from "@/lib/domain/expression/types";
import { asUuid } from "@/lib/domain/uuid";
import type { EmissionRewriteId, RewriteControl } from "../../emissionRewrites";
import { serializeWire } from "../../xpath/wire/serialize";
import { planConstraintCollections } from "../constraintCollections";
import { formExpressionEmission } from "../formExpressions";
import { FormPath } from "../formPath";

const VALIDATION = "count(/data/r/item[. = 'x']) > 0";

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: "withheld-count-form",
						name: "Survey",
						type: "survey",
						fields: [
							f({
								uuid: "withheld-count-q",
								id: "q",
								kind: "text",
								validate: VALIDATION,
							}),
							f({
								id: "r",
								kind: "repeat",
								children: [f({ id: "item", kind: "text" })],
							}),
						],
					},
				],
			},
		],
	});
	const [formUuid] = Object.keys(doc.forms);
	const field = Object.values(doc.fields).find((value) => value.id === "q");
	if (field === undefined || formUuid === undefined || !("validate" in field))
		throw new Error("The fixture holds a validated question.");
	return {
		doc,
		formUuid: asUuid(formUuid),
		field,
		validate: field.validate as Expression,
	};
}

/** A control that records every site it reaches. */
function control(withhold: readonly EmissionRewriteId[]): {
	readonly control: RewriteControl;
	readonly reached: EmissionRewriteId[];
} {
	const reached: EmissionRewriteId[] = [];
	return {
		control: { withhold: new Set(withhold), reached: (id) => reached.push(id) },
		reached,
	};
}

/** The validation printed as the XForm builder prints it: the plan's
 *  expression lowered with the plan's overrides. */
function printed(
	plan: ReturnType<typeof planConstraintCollections>,
	scene: ReturnType<typeof fixture>,
): string {
	const emission = formExpressionEmission(
		scene.doc,
		scene.formUuid,
		undefined,
		{},
	);
	return serializeWire(
		emission.lower(
			plan.expression,
			{ entity: "field", uuid: scene.field.uuid, slot: "validate" },
			plan.overrides,
		),
		{ target: "xform", constraint: true },
	).text;
}

describe("a validation's count, with validation-counts-moved withheld", () => {
	const path = FormPath.parse("/data/q");

	it("moves the count to a sibling and reports it where the control holds it", () => {
		const scene = fixture();
		const names: number[] = [];
		const { control: rewrites, reached } = control([]);
		const plan = planConstraintCollections(
			scene.validate,
			scene.field.uuid,
			scene.doc,
			path,
			(n) => {
				names.push(n);
				return `nova_constraint_q_${n + 1}`;
			},
			rewrites,
		);
		expect(plan.calculations.map((calculation) => calculation.name)).toEqual([
			"nova_constraint_q_1",
		]);
		expect(names).toEqual([0]);
		expect(reached).toEqual(["validation-counts-moved"]);
		expect(printed(plan, scene)).toBe("/data/nova_constraint_q_1 > 0");
	});

	it("keeps the count inline, names no sibling, and still reports the site", () => {
		const scene = fixture();
		const { control: rewrites, reached } = control(["validation-counts-moved"]);
		const plan = planConstraintCollections(
			scene.validate,
			scene.field.uuid,
			scene.doc,
			path,
			() => {
				throw new Error("A withheld plan names no generated node.");
			},
			rewrites,
		);
		expect(plan.expression).toBe(scene.validate);
		expect(plan.calculations).toEqual([]);
		expect(plan.overrides.size).toBe(0);
		expect(reached).toEqual(["validation-counts-moved"]);
		expect(printed(plan, scene)).toBe("count(/data/r/item[. = 'x']) > 0");
	});

	it("prints as today with no control, and reports nothing", () => {
		const scene = fixture();
		const plan = planConstraintCollections(
			scene.validate,
			scene.field.uuid,
			scene.doc,
			path,
			(n) => `nova_constraint_q_${n + 1}`,
		);
		expect(plan.calculations).toHaveLength(1);
		expect(printed(plan, scene)).toBe("/data/nova_constraint_q_1 > 0");
	});

	it("reports no site where no count would move", () => {
		const scene = fixture();
		const { control: rewrites, reached } = control(["validation-counts-moved"]);
		const plan = planConstraintCollections(
			{ kind: "match-all" },
			scene.field.uuid,
			scene.doc,
			path,
			(n) => `nova_constraint_q_${n + 1}`,
			rewrites,
		);
		expect(plan.calculations).toEqual([]);
		expect(reached).toEqual([]);
	});
});
