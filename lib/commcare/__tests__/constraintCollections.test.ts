import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { fieldExpressionValue } from "@/lib/domain";
import { planConstraintCollections } from "../xform/constraintCollections";
import { FormPath } from "../xform/formPath";
import { printWireXPathSource } from "../xpath/wireSource";

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
	const expression = fieldExpressionValue(field, "validate");
	if (!expression) throw new Error("Missing validation");
	return {
		original: printWireXPathSource(expression, doc),
		...planConstraintCollections(
			expression,
			field.uuid,
			doc,
			FormPath.root().child(field.id),
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
			expect(result.source).toBe(result.original);
		},
	);

	it("shares an independent count without moving the candidate comparison", () => {
		const result = plan(
			". = 'yes' and count(#form/choice[. = 'yes']) = 1 and count(#form/choice[. = 'yes']) < 2",
		);
		expect(result.calculations).toHaveLength(1);
		const calculation = result.calculations[0];
		expect(result.source).toBe(
			`. = 'yes' and ${calculation.path} = 1 and ${calculation.path} < 2`,
		);
		expect(calculation.source).toBe("count(#form/choice[. = 'yes'])");
		expect(
			FormPath.parse(calculation.path).parent().equals(FormPath.root()),
		).toBe(true);
	});
});
