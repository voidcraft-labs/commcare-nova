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

it("says which side of a shared entry can't be made, and what to change", async () => {
	const { doc } = advancedFixture({
		formType: "followup",
		operations: () => [own()],
	});
	const h = makeAuthoringHarness({}, doc);
	const entry = (input: Record<string, unknown>) =>
		h.call("createForm", {
			moduleUuid: "Households",
			name: "Entry",
			shared_form_uuid: "Households/Under test",
			...input,
		});
	// The target menu has no advanced form settings.
	await expect(entry({ moduleUuid: "Visits" })).resolves.toMatchObject({
		error: expect.stringContaining("“Visits” has none yet"),
	});
	// The type differs from the shared form's.
	await expect(entry({ type: "registration" })).resolves.toMatchObject({
		error: expect.stringContaining("is a followup form"),
	});
	// The shared form keeps its own text formatting.
	await expect(entry({ plain_text: true })).resolves.toMatchObject({
		error: expect.stringContaining("keeps its own text formatting"),
	});
	// The shared form decides whether its entries ask for the location.
	await expect(entry({ capture_location: true })).resolves.toMatchObject({
		error: expect.stringContaining("decides whether its entries ask"),
	});
	// An entry can't be shared; its own form can.
	await expect(entry({ name: "Morning visit" })).resolves.toMatchObject({
		ok: true,
	});
	// Named by its uuid, since the names an entry offers are shareable forms.
	const morning = Object.values(h.currentDoc().forms).find(
		(form) => form.name === "Morning visit",
	);
	// Nor can an edit give the entry a location request of its own.
	await expect(
		h.call("updateForm", {
			moduleUuid: "Households",
			formUuid: morning?.uuid,
			capture_location: true,
		}),
	).resolves.toMatchObject({
		error: expect.stringContaining(
			"whether it asks for the device location follows “Under test”",
		),
	});
	expect(morning && h.currentDoc().forms[morning.uuid]?.captureLocation).toBe(
		undefined,
	);
	await expect(
		entry({ name: "Night visit", shared_form_uuid: morning?.uuid }),
	).resolves.toMatchObject({
		error: expect.stringContaining(
			"is itself an entry that opens “Under test”",
		),
	});
});
