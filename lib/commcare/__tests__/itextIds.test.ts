import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { ItextUnit } from "@/lib/domain/expression/types";
import { itextIdFor, itextUnitForId } from "../xform/itextIds";

it("keeps itext identity through prepared ancestry and option-order changes", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Choices",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "group",
								id: "page",
								children: [
									f({
										kind: "single_select",
										id: "answer",
										options: [
											{ value: "a", label: proseText("A") },
											{ value: "b", label: proseText("B") },
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const saved = formStructure(doc, formUuid);
	if (saved === undefined) throw new Error("Missing form");
	const parent = [...saved.fields.values()].find(
		(field) => field.id === "page",
	);
	const field = [...saved.fields.values()].find(
		(field) => field.id === "answer",
	);
	if (parent === undefined || field?.choices?.kind !== "inline")
		throw new Error("Missing choices");
	const option = field.choices.options[0];
	const unit: ItextUnit = {
		field: field.uuid,
		role: "select-option-label",
		option: option.uuid,
	};
	expect(itextIdFor(doc, unit)).toBe("page-answer-opt0-label");
	const fields = new Map(saved.fields);
	fields.set(parent.uuid, { ...parent, id: "renamed" });
	fields.set(field.uuid, {
		...field,
		choices: { kind: "inline", options: [...field.choices.options].reverse() },
	});
	const prepared = { ...saved, fields };
	expect(itextIdFor(doc, unit, prepared)).toBe("renamed-answer-opt1-label");
	expect(
		itextUnitForId(doc, formUuid, "renamed-answer-opt1-label", prepared),
	).toEqual(unit);
	expect(
		itextUnitForId(doc, formUuid, "page-answer-opt0-label", prepared),
	).toBeUndefined();
	expect(itextIdFor(doc, unit)).toBe("page-answer-opt0-label");
});
