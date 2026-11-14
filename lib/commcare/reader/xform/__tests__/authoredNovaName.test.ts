/**
 * An author's question named like one of Nova's nodes. Nova reserves no
 * question name (`xform/generatedNodes.ts`): where an author named a question
 * `nova_trimmed_x` beside a question `x` that names a case, the allocator
 * gives Nova's own trimmed sibling the next suffix. The reader must read the
 * author's question as the question it is, with its control, and propose only
 * Nova's suffixed node as `x`'s trimmed sibling.
 *
 * Plausible failure: the author's question folded into Nova's node, which
 * would drop a question a person answers.
 */

import { expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { buildXForm } from "../../../xform/builder";
import { readFields, readForm, XMLNS } from "./formReading";

it("reads an author's nova_trimmed_x as their question, and Nova's suffixed node as x's sibling", async () => {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "x",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "nova_trimmed_x",
								label: proseText("Nickname"),
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const source = buildXForm(doc, formUuid, { xmlns: XMLNS });
	expect(source).toContain("<nova_trimmed_x_1");

	const reading = await readForm(source);
	const xform = reading.xform;
	if (xform === null) throw new Error("The form did not read.");
	expect(readFields(xform).map((field) => [field.id, field.kind])).toEqual([
		["x", "text"],
		["nova_trimmed_x", "text"],
	]);
	const nova = xform.nodes.get("nova_trimmed_x_1");
	const role = nova === undefined ? undefined : xform.roles.get(nova);
	expect(role).toMatchObject({
		kind: "generated-candidate",
		purpose: "trimmed",
	});
	expect(
		role?.kind === "generated-candidate" ? role.owner?.name : undefined,
	).toBe("x");
	expect(xform.candidates.map((node) => node.name)).toEqual([
		"nova_trimmed_x_1",
	]);
});
