import { describe, expect, it } from "vitest";
import {
	appDesignContractSchema,
	normalizeStoredAppDesignContract,
} from "@/lib/agent/design/contract";
import { fixtureValue, ids, makeContract } from "./fixtures";

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
