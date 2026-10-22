import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expressionSlotValue, proseText } from "@/lib/domain";
import { buildXForm } from "../xform/builder";
import { planConstraintCollections } from "../xform/constraintCollections";
import { FormPath } from "../xform/formPath";
import { onlyXml, readXmlEvidence, type XmlEvidence } from "./xmlEvidence";
import { xpathContains, xpathEvidence } from "./xpathEvidence";

function plan(validate: string) {
	const doc = buildDoc({
		modules: [
			{
				name: "Selection",
				forms: [
					{
						name: "Confirm",
						type: "survey",
						fields: [
							f({ kind: "text", id: "choice" }),
							f({ kind: "text", id: "other" }),
							f({ kind: "text", id: "confirm", validate }),
						],
					},
				],
			},
		],
	});
	const field = Object.values(doc.fields).find((f) => f.id === "confirm");
	if (!field) throw new Error("Missing confirmation");
	const expression = expressionSlotValue(doc, {
		entity: "field",
		uuid: field.uuid,
		slot: "validate",
	});
	if (!expression) throw new Error("Missing validation");
	return {
		original: expression,
		...planConstraintCollections(
			expression,
			field.uuid,
			doc,
			FormPath.root().child(field.id),
			(n) => `nova_constraint_${field.id}_${n}`,
		),
	};
}

describe("validation collection evaluation scope", () => {
	it.each([
		"count(#form/confirm[. = 'yes']) = 1",
		"count(#form/choice[. = #form/confirm]) = 1",
		"count(#form/choice[. = current()]) = 1",
		"count(#form/choice[position() = 1]) = 1",
		"count(#form/choice[../confirm = 'yes']) = 1",
		"count(#form/choice[count(#form/other[. = 'yes']) = 1]) = 1",
	])(
		"retains candidate-dependent or context-sensitive expression %s",
		(validate) => {
			const result = plan(validate);
			expect(result.calculations).toEqual([]);
			expect(result.expression).toBe(result.original);
			expect(result.overrides.size).toBe(0);
		},
	);

	it("shares an independent count without moving the candidate comparison", () => {
		const result = plan(
			". = 'yes' and count(#form/choice[. = 'yes']) = 1 and count(#form/choice[. = 'yes']) < 2",
		);
		expect(result.calculations).toHaveLength(1);
		const calculation = result.calculations[0];
		expect(result.expression).toBe(result.original);
		expect(result.overrides.size).toBe(2);
		expect(calculation.expression.kind).toBe("count");
		for (const replacement of result.overrides.values())
			expect(replacement).toEqual(calculation.path.toWire());
		expect(calculation.path.parent().equals(FormPath.root())).toBe(true);
	});
});

describe("validation collection lift on the wire", () => {
	function emit(kind: "text" | "single_select") {
		const doc = buildDoc({
			modules: [
				{
					name: "Roster",
					forms: [
						{
							name: "Gate",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "roster",
									children: [
										kind === "text"
											? f({ kind: "text", id: "answer" })
											: f({
													kind: "single_select",
													id: "answer",
													options: [
														{ value: "x", label: proseText("X") },
														{ value: "y", label: proseText("Y") },
													],
												}),
									],
								}),
								f({
									kind: "int",
									id: "gate",
									validate: "count(#form/roster/answer[. = 'x']) >= 1",
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const binds = readXmlEvidence(
			buildXForm(doc, formUuid, { xmlns: "urn:constraint-collections" }),
		);
		const bind = (nodeset: string) =>
			onlyXml(
				descendants(binds, "bind").filter(
					(node) => node.attributes.nodeset === nodeset,
				),
			);
		return {
			gate: bind("/data/gate"),
			lifted: bind("/data/nova_constraint_gate_0"),
		};
	}

	// Core substitutes the proposed answer while it evaluates a constraint, so
	// a filtered count stays correct on a device only as a calculate.
	it.each(["text", "single_select"] as const)(
		"lifts a filtered count over a %s repeat question into a generated calculate",
		(kind) => {
			const { gate, lifted } = emit(kind);
			expect(
				xpathContains(
					lifted.attributes.calculate,
					"count(/data/roster/answer[./. = 'x'])",
				),
			).toBe(true);
			expect(xpathEvidence(gate.attributes.constraint)).toEqual(
				xpathEvidence("/data/nova_constraint_gate_0 >= 1"),
			);
		},
	);
});

function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return [
		...(node.name === name ? [node] : []),
		...node.children.flatMap((child) => descendants(child, name)),
	];
}
