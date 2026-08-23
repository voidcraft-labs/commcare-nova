import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { searchBlueprint } from "@/lib/doc/searchBlueprint";
import { summarizeBlueprint } from "../summarizeBlueprint";

function nestedDoc() {
	const doc = buildDoc({
		modules: [
			{
				name: "Services",
				forms: [
					{
						name: "Intake",
						type: "survey" as const,
						fields: [f({ id: "intake_note", kind: "text" })],
					},
				],
			},
			{
				name: "Follow-up",
				forms: [
					{
						name: "Check in",
						type: "survey" as const,
						fields: [f({ id: "followup_note", kind: "text" })],
					},
				],
			},
		],
	});
	const parentUuid = doc.moduleOrder[0];
	const childUuid = doc.moduleOrder[1];
	if (parentUuid === undefined || childUuid === undefined) {
		throw new Error("nested fixture modules missing");
	}
	const child = doc.modules[childUuid];
	if (child === undefined) throw new Error("child module body missing");
	doc.modules[childUuid] = {
		...child,
		parentModuleUuid: parentUuid,
	};
	return { childUuid, doc, parentUuid };
}

describe("module hierarchy reads", () => {
	it("renders each module once as a parent-first menu tree", () => {
		const { childUuid, doc, parentUuid } = nestedDoc();
		const summary = summarizeBlueprint(doc);
		expect(summary).toContain(
			`- Module "Services" [uuid ${parentUuid}] [top-level menu]`,
		);
		expect(summary).toContain(
			`  - Module "Follow-up" [uuid ${childUuid}] [child menu of uuid ${parentUuid}]`,
		);
		expect(summary.match(/Module "Follow-up"/g)).toHaveLength(1);
	});

	it("returns parent and children and carries the full menu path", () => {
		const { childUuid, doc, parentUuid } = nestedDoc();
		const parent = searchBlueprint(doc, "Services").find(
			(result) => result.type === "module",
		);
		const child = searchBlueprint(doc, "Follow-up").find(
			(result) => result.type === "module",
		);
		expect(parent).toMatchObject({
			type: "module",
			moduleUuid: parentUuid,
			parentModuleUuid: null,
			childModuleUuids: [childUuid],
			context: 'Menu "Services"',
		});
		expect(child).toMatchObject({
			type: "module",
			moduleUuid: childUuid,
			parentModuleUuid: parentUuid,
			childModuleUuids: [],
			context: 'Menu "Services" > "Follow-up"',
		});
		const form = searchBlueprint(doc, "Check in").find(
			(result) => result.type === "form",
		);
		expect(form?.context).toContain('Menu "Services" > "Follow-up"');
	});
});
