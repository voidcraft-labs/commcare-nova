import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { advancedFixture } from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { own } from "@/lib/commcare/__tests__/placementFixture";

it("creates, reads and repairs a shared entry by the names a person sees", async () => {
	const { doc, formUuid: parent } = advancedFixture({
		formType: "followup",
		operations: () => [own()],
	});
	const h = makeAuthoringHarness({}, doc);
	const form = { formUuid: "Morning visit" };
	await expect(
		h.call("createForm", {
			moduleUuid: "Households",
			name: form.formUuid,
			shared_form_uuid: "Households/Under test",
		}),
	).resolves.toMatchObject({ ok: true });
	await expect(h.call("getForm", form)).resolves.toMatchObject({
		sharedForm: { formUuid: parent, name: "Under test" },
		form: {
			fields: expect.arrayContaining([expect.objectContaining({ id: "name" })]),
		},
	});
	await expect(h.call("getCaseOperations", form)).resolves.toMatchObject({
		sharedForm: { formUuid: parent, name: "Under test" },
		operations: [expect.objectContaining({ action: "own" })],
	});
	await expect(
		h.call("editFormEntry", {
			...form,
			edit: {
				operation: "add-choice",
				value: {
					name: "Contact",
					caseType: "household",
					source: { kind: "choose", module: "Households" },
				},
			},
		}),
	).resolves.toMatchObject({ ok: true });
	await expect(
		h.call("editFormEntry", {
			...form,
			edit: { operation: "remove-choice", uuid: "Households" },
		}),
	).resolves.toMatchObject({ ok: true });
	await expect(
		h.call("editFormEntry", {
			...form,
			edit: {
				operation: "restore-shared-choice",
				uuid: "Households",
				after: "Contact",
			},
		}),
	).resolves.toMatchObject({ ok: true });
	await expect(h.call("getForm", form)).resolves.toMatchObject({
		form: {
			caseSelections: [
				expect.objectContaining({ name: "Contact" }),
				expect.objectContaining({ name: "Households" }),
			],
		},
	});
});
