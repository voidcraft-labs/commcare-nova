/**
 * `removeModule` — the tool-level contract around module deletion:
 *
 *   - removing the ONLY module of a named app rejects at the gate
 *     (re-introducing `NO_MODULES`) with nothing persisted — the
 *     direct pin for the one removal the single rule forbids;
 *   - removing a case type's last owning module retires its record in
 *     the SAME committed batch (the cascade is explicit mutations from
 *     the batch-building layer, so the gate never sees
 *     `MISSING_CHILD_CASE_MODULE` and historical event-log replay is
 *     untouched);
 *   - a removal whose retired type is still referenced fails the call
 *     naming the references, with nothing persisted.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
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
					forms: [{ name: "Care home", type: "survey" }],
				},
				{
					name: "Visits",
					forms: [{ name: "Visit", type: "survey" }],
				},
			],
		});
		const [parentUuid, childUuid] = doc.moduleOrder;
		doc.modules[childUuid].parentModuleUuid = parentUuid;
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(removeModuleTool, { moduleUuid: parentUuid });

		expect(h.currentDoc()).toBe(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(out.result).toMatchObject({
			error: expect.stringContaining('"Visits"'),
		});
		expect((out.result as { error: string }).error).toContain("Move or remove");
	});

	it("rejects removing the ONLY module — the batch would re-introduce NO_MODULES", async () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [record("patient")],
			modules: [moduleSpec("Patients", "patient")],
		});
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(removeModuleTool, {
			moduleUuid: doc.moduleOrder[0],
		});

		expect(h.currentDoc()).toBe(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(out.result).toMatchObject({
			error: expect.stringContaining("at least one module"),
		});
	});

	it("retires the removed module's case-type record in the same committed batch", async () => {
		// "visit" is a child type whose record would otherwise be orphaned —
		// exactly the shape whose leftover record introduces
		// MISSING_CHILD_CASE_MODULE. The cascade removes it alongside, so
		// the batch commits.
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [record("patient"), record("visit", "patient")],
			modules: [
				moduleSpec("Patients", "patient"),
				moduleSpec("Visits", "visit"),
			],
		});
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(removeModuleTool, {
			moduleUuid: doc.moduleOrder[1],
		});

		expect(out.result).toMatchObject({
			message: expect.stringContaining('Case type "visit"'),
		});
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(out.mutations).toEqual([
			{ kind: "removeModule", uuid: expect.any(String) },
			{ kind: "retireCaseType", caseType: "visit" },
		]);
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
		const h = makeToolWorkspaceHarness(doc);

		const out = await h.runTool(removeModuleTool, {
			moduleUuid: doc.moduleOrder[1],
		});

		expect(h.currentDoc()).toBe(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
		const result = out.result as { error: string };
		expect(result.error).toContain('"visit_note"');
		expect(result.error).toContain("Remove or retarget");
	});
});
