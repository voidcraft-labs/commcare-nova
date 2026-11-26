/**
 * A question saved to a case's location or its worker id, read back from
 * Nova's own export.
 *
 * Contract: Nova guards every key it keeps in a 255-character column
 * (`caseScalarTextGuard.ts::isCaseScalarTextProperty`: a case's name, its
 * external id, `location_id` and `hq_user_id`) with the check on the question
 * and a `nova_trimmed_` sibling the update names. Reading that export takes
 * the sibling as the question's trimmed value, so the question keeps its own
 * check and the write keeps its question, beside the question's write of an
 * ordinary property.
 *
 * Plausible failure: the reader taking the sibling as a trimmed value only
 * for a name or an external id, so the location's sibling read as the
 * person's own Hidden Value and the question's check as a check no change
 * needs (`unrecognized`), which refused every app saving a location from a
 * question at its first re-read (the matrix row
 * `hq-case-management/location-id-write`).
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "./heldReading";

function savedTwice(key: "location_id" | "hq_user_id"): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "member",
				properties: [{ name: "status_note", label: proseText("Status") }],
			},
		],
		modules: [
			{
				name: "Members",
				caseType: "member",
				forms: [
					{
						name: "Followup Form",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "status_note",
								label: "Status",
								caseWrite: { caseType: "member", property: "status_note" },
							}),
						],
					},
				],
			},
		],
	});
	const field = Object.values(doc.fields).find(
		(one) => one.id === "status_note",
	);
	const [formUuid, form] = Object.entries(doc.forms)[0] ?? [];
	const own = form?.caseOperations?.find((one) => one.action === "own");
	if (field === undefined || form === undefined || own === undefined)
		throw new Error("The form saves its question to its own case.");
	return {
		...doc,
		forms: {
			...doc.forms,
			[formUuid as string]: {
				...form,
				caseOperations: (form.caseOperations ?? []).map((one) =>
					one === own
						? {
								...own,
								writes: [
									...(own.writes ?? []),
									{ property: key, value: term(formField(field.uuid)) },
								],
							}
						: one,
				),
			},
		},
	} as BlueprintDoc;
}

describe("a question saved to an ordinary property and to a guarded key", () => {
	it.each(["location_id", "hq_user_id"] as const)(
		"reads Nova's export of a write to %s through its trimmed sibling, with nothing left over",
		async (key) => {
			const body = exportedBody(savedTwice(key));
			const update = (
				body.modules as {
					forms: {
						actions: {
							update_case: {
								update: Record<string, { question_path: string }>;
							};
						};
					}[];
				}[]
			)[0]?.forms[0]?.actions.update_case.update;
			expect(update?.[key]?.question_path).toBe(
				"/data/nova_trimmed_status_note",
			);
			const outcome = readHqApp(await inputFor(body));
			if (outcome.kind !== "read")
				throw new Error(
					`The form does not come in: ${outcome.findings.map((one) => `${one.code} ${one.detail.name ?? ""}`).join(", ")}`,
				);
			const writes = Object.values(outcome.draft.doc.forms)[0]
				?.caseOperations?.find((one) => one.action === "own")
				?.writes?.map((one) => one.property);
			expect(writes).toEqual(["status_note", key]);
		},
	);
});
