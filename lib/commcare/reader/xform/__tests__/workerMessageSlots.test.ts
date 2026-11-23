import { produce } from "immer";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { applyMutations } from "@/lib/doc/mutations";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";

it("keeps the entered message, capture starting answers and each constraint after a wording edit", async () => {
	const confirmation = testUuid("confirmation");
	const image = testUuid("image");
	const report = testUuid("report");
	const note = testUuid("note");
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							{
								uuid: confirmation,
								id: "confirmation",
								kind: "label",
								label: "Report reviewed",
								askForConfirmation: true,
								required: "true()",
								hint: proseText("Check the date"),
								help: proseText("Confirm today's report"),
								default_value: "'later'",
								validate: ". = 'OK'",
								validate_msg: proseText("Please confirm"),
							},
							{
								uuid: image,
								id: "photo",
								kind: "image",
								label: "Photo",
								default_value: "''",
								validate: ". != 'unusable.jpg'",
								help: proseText("Choose a clear photo"),
							},
							{
								uuid: report,
								id: "report",
								kind: "file",
								label: "Report",
								default_value: "'carry-forward.pdf'",
								validate: ". != 'blocked.pdf'",
								validate_msg: proseText("Choose a different file"),
							},
							{ uuid: note, id: "note", kind: "text", label: "Visit note" },
						],
					},
				],
			},
		],
	});
	const read = async (document: BlueprintDoc) => {
		const result = readHqApp(
			await inputFor(exportedBody(document), {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(document, DERIVED_WIRE_IDENTITY),
				),
			}),
		);
		expect(result.kind === "account" ? result.findings : []).toEqual([]);
		expect(result.defects).toEqual([]);
		if (result.kind !== "read") throw new Error("The visit could not be read.");
		return result.draft.doc;
	};
	const first = await read(doc);
	const edited = produce(first, (draft) => {
		applyMutations(draft, [
			{
				kind: "updateField",
				targetKind: "text",
				uuid: note,
				patch: { label: proseText("What happened at the visit?") },
			},
		]);
	});
	for (const actual of [first, await read(edited)]) {
		for (const id of [confirmation, image, report]) {
			const original = doc.fields[id];
			expect(actual.fields[id]).toMatchObject(original);
		}
	}
});
