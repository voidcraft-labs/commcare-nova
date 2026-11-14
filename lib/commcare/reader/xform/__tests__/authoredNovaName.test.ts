/**
 * An author's question named like one of Nova's nodes. Nova reserves no
 * question name (`xform/generatedNodes.ts`): where an author named a question
 * `nova_trimmed_x` beside a question `x` that names a case, the allocator
 * gives Nova's own trimmed sibling the next suffix. The reader must read the
 * author's question as the question it is, with its control, and propose only
 * Nova's suffixed node as `x`'s trimmed sibling.
 *
 * The whole reading of the export reads back to the document: two fields,
 * `x` and the author's `nova_trimmed_x`, with `x` the case name's source and
 * no finding.
 *
 * Plausible failures: the author's question folded into Nova's node, which
 * would drop a question a person answers; the case management stage settling
 * the author's question as the name's trimmed sibling, so the name reads
 * the author's question.
 */

import { expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { fieldCaseWriteViews, proseText } from "@/lib/domain";
import { buildXForm } from "../../../xform/builder";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import { readFields, readForm, XMLNS } from "./formReading";

function authoredNovaNameApp() {
	return buildDoc({
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
}

it("reads an author's nova_trimmed_x as their question, and Nova's suffixed node as x's sibling", async () => {
	const doc = authoredNovaNameApp();
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

it("reads the export whole, with x the case name's source and the author's question a field", async () => {
	const outcome = readHqApp(
		await inputFor(exportedBody(authoredNovaNameApp())),
	);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") throw new Error("The export did not read.");
	const doc = outcome.draft.doc;
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const fields = doc.fieldOrder[formUuid].map((uuid) => doc.fields[uuid]);
	expect(fields.map((field) => [field.id, field.kind])).toEqual([
		["x", "text"],
		["nova_trimmed_x", "text"],
	]);
	const [x, nickname] = fields;
	expect(
		fieldCaseWriteViews(doc, x.uuid).map((view) => [view.slot, view.property]),
	).toEqual([["name", "case_name"]]);
	expect(fieldCaseWriteViews(doc, nickname.uuid)).toEqual([]);
});
