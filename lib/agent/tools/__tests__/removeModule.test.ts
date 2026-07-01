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

import { describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { removeModuleTool } from "../removeModule";

function makeCtx() {
	const recordMutations = vi.fn().mockResolvedValue([]);
	const ctx: ToolExecutionContext = {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
		recordMutations,
		recordMutationStages: vi.fn().mockResolvedValue([]),
		recordConversation: vi.fn(),
	};
	return { ctx, recordMutations };
}

const registrationFields = (caseType: string) => [
	f({
		kind: "text",
		id: "case_name",
		label: "Name",
		case_property_on: caseType,
	}),
	f({
		kind: "text",
		id: "village",
		label: "Village",
		case_property_on: caseType,
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
			{ name: "case_name", label: "Name" },
			{ name: "village", label: "Village" },
		],
		...(parentType && { parent_type: parentType }),
	};
}

describe("removeModule", () => {
	it("rejects removing the ONLY module — the batch would re-introduce NO_MODULES", async () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [record("patient")],
			modules: [moduleSpec("Patients", "patient")],
		});
		const { ctx, recordMutations } = makeCtx();

		const out = await removeModuleTool.execute({ moduleIndex: 0 }, ctx, doc);

		expect(out.newDoc).toBe(doc);
		expect(recordMutations).not.toHaveBeenCalled();
		expect(out.result).toMatchObject({
			error: expect.stringContaining("no modules"),
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
		const { ctx, recordMutations } = makeCtx();

		const out = await removeModuleTool.execute({ moduleIndex: 1 }, ctx, doc);

		expect(out.result).toMatchObject({
			message: expect.stringContaining('Case type "visit"'),
		});
		expect(recordMutations).toHaveBeenCalledTimes(1);
		expect(out.mutations).toEqual([
			{ kind: "removeModule", uuid: expect.any(String) },
			{ kind: "retireCaseType", caseType: "visit" },
		]);
		expect(out.newDoc.moduleOrder).toHaveLength(1);
		expect(out.newDoc.caseTypes).toEqual([record("patient")]);
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
									label: "Visit note",
									case_property_on: "visit",
								}),
							],
						},
					],
				},
				moduleSpec("Visits", "visit"),
			],
		});
		const { ctx, recordMutations } = makeCtx();

		const out = await removeModuleTool.execute({ moduleIndex: 1 }, ctx, doc);

		expect(out.newDoc).toBe(doc);
		expect(recordMutations).not.toHaveBeenCalled();
		const result = out.result as { error: string };
		expect(result.error).toContain('"visit_note"');
		expect(result.error).toContain("Remove or retarget");
	});
});
