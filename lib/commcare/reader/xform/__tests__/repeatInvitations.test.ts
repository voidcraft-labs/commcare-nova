import { produce } from "immer";
import { expect, it } from "vitest";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type LanguageTag,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import { repeatInvitationsApp } from "@/proof/targeted/documents/repeatInvitations";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";

it("retains each invitation and its translation when the question between visits changes wording", async () => {
	const original = repeatInvitationsApp();
	const read = async (doc: BlueprintDoc) => {
		const source = await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
		});
		const result = readHqApp(source);
		expect(result.kind === "account" ? result.findings : []).toEqual([]);
		expect(result.defects).toEqual([]);
		if (result.kind !== "read")
			throw new Error("Failed to read the visit questionnaire.");
		return result.draft.doc;
	};
	const first = await read(original);
	const repeat = Object.values(original.fields).find(
		(field) => field.kind === "repeat",
	);
	const summary = Object.values(first.fields).find(
		(field) => field.id === "summary",
	);
	if (!repeat || !summary)
		throw new Error("The visit or its summary is missing.");
	const edited = produce(first, (draft) => {
		applyMutations(draft, [
			{
				kind: "updateField",
				targetKind: "text",
				uuid: summary.uuid,
				patch: { label: proseText("How did the visit go?") },
			},
		]);
	});
	for (const document of [first, await read(edited)]) {
		expect(document.fields[repeat.uuid]).toMatchObject({
			addFirstLabel: proseText("Record the first visit"),
			addLabel: proseText("Record another visit"),
		});
		const spanish = document.localization?.translations["spa" as LanguageTag];
		expect(
			spanish?.[makeTranslationUnitId("field", repeat.uuid, "addFirstLabel")]
				?.value,
		).toEqual(proseText("Registrar la primera visita"));
		expect(
			spanish?.[makeTranslationUnitId("field", repeat.uuid, "addLabel")]?.value,
		).toEqual(proseText("Registrar otra visita"));
	}
});
