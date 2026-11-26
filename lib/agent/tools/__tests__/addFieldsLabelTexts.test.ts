/**
 * SA `add_fields` with a label's other texts: an extended text, a QR code and
 * a spoken text handed to the tool are stored on the new field.
 *
 * Plausible failure: the schema admits a slot that `flatFieldToField` does not
 * copy, so the call reports success and the field holds nothing.
 */

import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";

function oneFieldDoc(): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [f({ kind: "text", id: "qa", label: proseText("A") })],
						},
					],
				},
			],
		}),
	);
}

it("stores the extended text, QR code and spoken text of a new field", async () => {
	const doc = oneFieldDoc();
	const h = makeToolWorkspaceHarness(doc);
	const moduleUuid = doc.moduleOrder[0];
	const out = await h.runTool(addFieldsTool, {
		moduleUuid,
		formUuid: doc.formOrder[moduleUuid][0],
		fields: [
			{
				kind: "text",
				id: "card",
				label: proseText("Card"),
				extended_text: proseText("The number on the card"),
				qr_code: proseText("CARD-1"),
				spoken_text: proseText("Read the card number"),
			},
		],
	});
	expect("ok" in out.result).toBe(true);
	const card = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "card",
	) as unknown as Record<
		string,
		Parameters<typeof proseTemplateText>[0] | undefined
	>;
	expect(
		(["extended_text", "qr_code", "spoken_text"] as const).map((slot) => {
			const held = card[slot];
			return held === undefined ? undefined : proseTemplateText(held);
		}),
	).toEqual(["The number on the card", "CARD-1", "Read the card number"]);
});
