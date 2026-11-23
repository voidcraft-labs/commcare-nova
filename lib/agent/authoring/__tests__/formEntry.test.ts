import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { advancedFixture } from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { own } from "@/lib/commcare/__tests__/placementFixture";

it("creates and reads named opening supplies without a generated path and keeps their meaning after renaming a record", async () => {
	const { doc, formUuid } = advancedFixture({
		formType: "followup",
		operations: () => [own()],
	});
	const h = makeAuthoringHarness({}, doc);
	const form = { formUuid: "Under test" };
	const add = await h.call("editFormEntry", {
		...form,
		edit: {
			operation: "add-choice",
			value: {
				name: "Second household",
				source: { kind: "choose", module: "Households" },
				caseType: "household",
			},
		},
	});
	expect(add).toMatchObject({ ok: true });
	const read = await h.call("editFormEntry", {
		...form,
		edit: {
			operation: "add-value",
			value: { key: "recipient", value: "opening-record('Second household')" },
		},
	});
	expect(read).toMatchObject({ ok: true });
	const rename = await h.call("editFormEntry", {
		...form,
		edit: {
			operation: "edit-choice",
			uuid: "Second household",
			patch: { name: "Receiving household" },
		},
	});
	expect(rename).toMatchObject({ ok: true });
	const addConnected = await h.call("editFormEntry", {
		...form,
		edit: {
			operation: "add-choice",
			value: {
				name: "Connected household",
				caseType: "household",
				source: {
					kind: "choose",
					module: "Households",
					under: {
						selection: "Receiving household",
						identifier: "home",
						relationship: { question: "status" },
					},
				},
			},
		},
	});
	expect(addConnected).toMatchObject({ ok: true });
	const replaceConnection = await h.call("editFormEntry", {
		...form,
		edit: {
			operation: "edit-choice",
			uuid: "Connected household",
			patch: {
				source: {
					kind: "choose",
					module: "Households",
					under: {
						selection: "Receiving household",
						identifier: "home",
						relationship: { question: "owner_q" },
					},
				},
			},
		},
	});
	expect(replaceConnection).toMatchObject({ ok: true });
	const saved = h.currentDoc().forms[formUuid];
	const choice = saved.caseSelections?.find(
		(row) => row.name === "Receiving household",
	);
	expect(choice).toBeDefined();
	expect(saved.computedDatums?.[0].value).toMatchObject({
		kind: "term",
		term: {
			kind: "session-datum",
			datum: { kind: "form-selection", selection: choice?.uuid },
		},
	});
	const viewed = await h.call("getForm", form);
	expect(viewed).toMatchObject({
		form: {
			caseSelections: expect.arrayContaining([
				expect.objectContaining({
					name: "Connected household",
					source: expect.objectContaining({
						under: expect.objectContaining({
							relationship: { question: "owner_q" },
						}),
					}),
				}),
			]),
			computedDatums: [
				{ key: "recipient", value: "opening-record('Receiving household')" },
			],
		},
	});
	expect(JSON.stringify(viewed)).not.toContain("use_second_household");
});
