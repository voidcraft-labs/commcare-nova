import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText, simpleSearchInputDef } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

describe("useBlueprintMutations.moveColumnOnSurface", () => {
	it("an index-based Results move records one anchored command and preserves Details order", () => {
		const initial = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "case_name",
							label: proseText("Name"),
						},
						{
							name: "age",
							label: proseText("Age"),
							data_type: "int",
						},
						{
							name: "status",
							label: proseText("Status"),
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{
							field: "case_name",
							header: "Name",
						},
						{
							field: "age",
							header: "Age",
						},
						{
							field: "status",
							header: "Status",
						},
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(initial);
		const moduleUuid = initial.moduleOrder[0];
		const initialColumns =
			initial.modules[moduleUuid].caseListConfig?.columns ?? [];
		const movedUuid = initialColumns[2]?.uuid;
		if (movedUuid === undefined) throw new Error("fixture column missing");
		const store = createBlueprintDocStore();
		store.getState().load(initial);
		store.getState().startTracking();
		const mutations = createBlueprintMutations(store, {
			canEdit: true,
			authoringLanguage: null,
			lookupCommitState: {
				kind: "unmanaged",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			},
		});
		const before = store.getState();
		if (before === undefined) throw new Error("store missing");
		mutations.moveColumnOnSurface(moduleUuid, movedUuid, "list", 0);
		const after = store.getState();
		if (after === undefined) throw new Error("store missing after move");
		const batches = after.peekCommandBatches();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
		expect(batches[0][0]).toEqual({
			kind: "moveColumn",
			moduleUuid,
			uuid: movedUuid,
			surface: "list",
			after: null,
		});
		const config = after.modules[moduleUuid].caseListConfig;
		expect(config?.listColumnOrder[0]).toBe(movedUuid);
		// Details did not move with Results.
		expect(config?.detailColumnOrder).toEqual(
			initial.modules[moduleUuid].caseListConfig?.detailColumnOrder,
		);
	});
});
describe("useBlueprintMutations.moveSearchInputToIndex", () => {
	it("an index-based search-field move records one anchored command", () => {
		const first = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000331"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const second = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000332"),
			"external_id",
			"External ID",
			"text",
			"external_id",
		);
		const config = caseListConfig([
			{
				field: "case_name",
				header: "Name",
			},
		]);
		config.searchInputs = [first, second];
		const initial = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "case_name",
							label: proseText("Name"),
						},
						{
							name: "external_id",
							label: proseText("External ID"),
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: config,
					caseSearchConfig: {},
				},
			],
		});
		assertAdmittedDoc(initial);
		const moduleUuid = initial.moduleOrder[0];
		const store = createBlueprintDocStore();
		store.getState().load(initial);
		store.getState().startTracking();
		const mutations = createBlueprintMutations(store, {
			canEdit: true,
			authoringLanguage: null,
			lookupCommitState: {
				kind: "unmanaged",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			},
		});
		const before = store.getState();
		if (before === undefined) throw new Error("store missing");
		const outcome = mutations.moveSearchInputToIndex(moduleUuid, first.uuid, 1);
		expect(outcome).toEqual({
			ok: true,
		});
		const after = store.getState();
		if (after === undefined) throw new Error("store missing after move");
		const batches = after.peekCommandBatches();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
		expect(batches[0][0]).toEqual({
			kind: "moveSearchInput",
			moduleUuid,
			uuid: first.uuid,
			after: second.uuid,
		});
		const inputs = after.modules[moduleUuid].caseListConfig?.searchInputs ?? [];
		expect(inputs.map((input) => input.uuid)).toEqual([
			second.uuid,
			first.uuid,
		]);
	});
});
