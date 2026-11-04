/**
 * Actual admitted workspace module deletion with a controlled host receipt.
 * The batch and resulting document are exercised; native SQL tests own durable
 * transaction atomicity.
 *
 *   - removing the ONLY module of a named app rejects at the gate
 *     (re-introducing `NO_MODULES`) with nothing persisted — the
 *     direct pin for the one removal the single rule forbids;
 *   - removing a case type's last owning module retires its record in
 *     the SAME committed batch (the cascade is explicit mutations from
 *     the batch-building layer, so historical event-log replay is
 *     untouched);
 *   - a removal whose retired type is still referenced fails the call
 *     naming the references, with nothing persisted.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { removeModuleTool } from "../removeModule";

const registrationFields = (caseType: string) => [
	f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType, property: "case_name" },
	}),
	f({
		kind: "text",
		id: "village",
		label: proseText("Village"),
		caseWrite: { caseType, property: "village" },
	}),
];

function moduleSpec(name: string, caseType: string) {
	return {
		name,
		caseType,
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		forms: [
			{
				name: `Register ${caseType}`,
				type: "registration" as const,
				fields: registrationFields(caseType),
			},
		],
	};
}

function record(name: string, parentType?: string) {
	return {
		name,
		properties: [
			{ name: "case_name", label: proseText("Name") },
			{ name: "village", label: proseText("Village") },
		],
		...(parentType && { parent_type: parentType }),
	};
}

describe("removeModule", () => {
	it("names child menus and the repair before refusing parent removal", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Care",
					forms: [
						{
							name: "Care home",
							type: "survey",
							fields: [f({ id: "home", kind: "text" })],
						},
					],
				},
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ id: "visit", kind: "text" })],
						},
					],
				},
			],
		});
		const [parentUuid, childUuid] = doc.moduleOrder;
		doc.modules[childUuid].parentModuleUuid = parentUuid;
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));

		const out = await h.runTool(removeModuleTool, { moduleUuid: parentUuid });

		expect(h.currentDoc()).toEqual(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(out.result).toMatchObject({
			error: expect.stringContaining('"Visits"'),
		});
		expect(
			typeof out.result === "object" &&
				"error" in out.result &&
				out.result.error,
		).toContain("Move or remove");
	});

	it("rejects removing the ONLY module — the batch would re-introduce NO_MODULES", async () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [record("patient")],
			modules: [moduleSpec("Patients", "patient")],
		});
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));

		const out = await h.runTool(removeModuleTool, {
			moduleUuid: doc.moduleOrder[0],
		});

		expect(h.currentDoc()).toEqual(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(out.result).toMatchObject({
			error: expect.stringContaining("at least one module"),
		});
	});

	it("retires the removed module's case-type record in the same committed batch", async () => {
		// "visit" is a child type whose record would otherwise be left with
		// no module and no use. The cascade removes it in the same batch.
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [record("patient"), record("visit", "patient")],
			modules: [
				moduleSpec("Patients", "patient"),
				moduleSpec("Visits", "visit"),
			],
		});
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));

		const out = await h.runTool(removeModuleTool, {
			moduleUuid: doc.moduleOrder[1],
		});

		expect(out.result).toMatchObject({
			ok: true,
			retiredCaseType: "visit",
		});
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(out.mutations).toEqual([
			{ kind: "removeModule", uuid: expect.any(String) },
			{ kind: "retireCaseType", caseType: "visit" },
		]);
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().moduleOrder).toHaveLength(1);
		expect(h.currentDoc().caseTypes).toEqual([record("patient")]);
	});

	it("fails the call naming the references when the retired type is still referenced", async () => {
		// A field in Patients still writes to "visit" — the removal must
		// reject with a repair the user can perform, not the dead-end
		// "add a module with case_type visit" the validator would give.
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [record("patient"), record("visit", "patient")],
			modules: [
				{
					...moduleSpec("Patients", "patient"),
					forms: [
						{
							name: "Register patient",
							type: "registration" as const,
							fields: [
								...registrationFields("patient"),
								f({
									kind: "text",
									id: "visit_name",
									label: proseText("Visit name"),
									caseWrite: { caseType: "visit", property: "case_name" },
								}),
								f({
									kind: "text",
									id: "visit_note",
									label: proseText("Visit note"),
									caseWrite: { caseType: "visit", property: "visit_note" },
								}),
							],
						},
					],
				},
				moduleSpec("Visits", "visit"),
			],
		});
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));

		const out = await h.runTool(removeModuleTool, {
			moduleUuid: doc.moduleOrder[1],
		});

		expect(h.currentDoc()).toEqual(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		const result = out.result;
		if (typeof result !== "object" || !("error" in result))
			throw new Error("expected retirement refusal");
		// The questions save to "visit" through the form's child-case change,
		// which the refusal names.
		const childCase = Object.values(h.currentDoc().forms)
			.flatMap((form) => form.caseOperations ?? [])
			.find((operation) => operation.caseType === "visit");
		if (childCase === undefined) throw new Error("Missing the visit change.");
		expect(result.error).toContain(`"${childCase.id}"`);
		expect(result.error).toContain("Remove or retarget");
	});
});
