import { describe, expect, it } from "vitest";
import {
	appDesignContractSchema,
	normalizeStoredAppDesignContract,
} from "@/lib/agent/design/contract";
import {
	addPatientReviewWorkflow,
	fixtureValue,
	ids,
	makeContract,
} from "./fixtures";

describe("stored Design Contract normalization", () => {
	it("fills omitted additive collections only at the storage boundary", () => {
		const stored = structuredClone(makeContract()) as unknown as Record<
			string,
			unknown
		>;
		delete stored.moduleCompositions;
		delete stored.formCompositions;
		delete stored.lookupTables;

		expect(appDesignContractSchema.safeParse(stored).success).toBe(false);
		const normalized = normalizeStoredAppDesignContract(stored);
		expect(normalized).toMatchObject({
			schemaVersion: 1,
			moduleCompositions: [],
			formCompositions: [],
			lookupTables: [],
		});
		expect(() =>
			normalizeStoredAppDesignContract({ ...stored, lookupTables: null }),
		).toThrow();
	});

	it("moves historical workflow-only list selection to its module", () => {
		const stored = structuredClone(makeContract()) as unknown as Record<
			string,
			unknown
		>;
		const lists = stored.lists as Array<Record<string, unknown>>;
		const list = fixtureValue(lists[0], "patient list");
		const modules = stored.moduleCompositions as Array<Record<string, unknown>>;
		delete fixtureValue(modules[0], "patient module").selection;
		list.selectionWorkflowId = ids.taskVisit;

		expect(appDesignContractSchema.safeParse(stored).success).toBe(false);
		expect(
			normalizeStoredAppDesignContract(stored).moduleCompositions[0]?.selection,
		).toEqual({
			workflowIds: [ids.taskVisit],
			cases: "one",
		});
	});

	it("derives complete current coverage instead of preserving a legacy usage hint", () => {
		const stored = structuredClone(makeContract()) as unknown as Record<
			string,
			unknown
		>;
		const lists = stored.lists as Array<Record<string, unknown>>;
		const list = fixtureValue(lists[0], "patient list");
		const modules = stored.moduleCompositions as Array<Record<string, unknown>>;
		delete fixtureValue(modules[0], "patient module").selection;
		/* The former schema proved only that this workflow existed. It did not
		 * require its selected context or form placement to match the list. */
		list.selectionWorkflowId = ids.taskRegister;

		const currentSpelling = structuredClone(stored);
		delete fixtureValue(
			(currentSpelling.lists as Array<Record<string, unknown>>)[0],
			"patient list",
		).selectionWorkflowId;
		fixtureValue(
			(currentSpelling.moduleCompositions as Array<Record<string, unknown>>)[0],
			"patient module",
		).selection = {
			workflowIds: [ids.taskRegister],
			cases: "one",
		};
		expect(appDesignContractSchema.safeParse(currentSpelling).success).toBe(
			false,
		);

		expect(
			normalizeStoredAppDesignContract(stored).moduleCompositions[0]?.selection,
		).toEqual({
			workflowIds: [ids.taskVisit],
			cases: "one",
		});
	});

	it("derives every module consumer from one legacy list hint", () => {
		const contract = makeContract();
		addPatientReviewWorkflow(contract);
		const stored = structuredClone(contract) as unknown as Record<
			string,
			unknown
		>;
		const module = fixtureValue(
			(stored.moduleCompositions as Array<Record<string, unknown>>)[0],
			"patient module",
		);
		delete module.selection;
		fixtureValue(
			(stored.lists as Array<Record<string, unknown>>)[0],
			"patient list",
		).selectionWorkflowId = ids.taskVisit;

		expect(
			normalizeStoredAppDesignContract(stored).moduleCompositions[0]?.selection,
		).toEqual({
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "one",
		});
	});

	it("restores implicit one-case semantics for a legacy form-host without a list", () => {
		const stored = structuredClone(makeContract()) as unknown as Record<
			string,
			unknown
		>;
		const module = fixtureValue(
			(stored.moduleCompositions as Array<Record<string, unknown>>)[0],
			"patient module",
		);
		module.role = "form-host";
		module.listIds = [];
		delete module.selection;
		stored.lists = [];
		stored.access = [];
		fixtureValue(
			(stored.navigation as Array<Record<string, unknown>>)[0],
			"patient navigation",
		).listIds = [];

		expect(
			normalizeStoredAppDesignContract(stored).moduleCompositions[0]?.selection,
		).toEqual({
			workflowIds: [ids.taskVisit],
			cases: "one",
		});
	});

	it("does not synthesize a missing stable lookup identity", () => {
		const stored = structuredClone(makeContract()) as unknown as ReturnType<
			typeof makeContract
		>;
		const risk = fixtureValue(
			stored.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		) as unknown as Record<string, unknown>;
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			valueColumnId: "018f0000-0000-7000-8000-000000000102",
			labelColumnId: "018f0000-0000-7000-8000-000000000103",
		};
		expect(() => normalizeStoredAppDesignContract(stored)).toThrow();
	});
});
