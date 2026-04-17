import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/doc/types";

function emptyDoc(): BlueprintDoc {
	return {
		appId: "test",
		appName: "Original",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("applyMutation: setAppName", () => {
	it("updates appName", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setAppName", name: "Renamed" });
		});
		expect(next.appName).toBe("Renamed");
	});

	it("does not mutate the input doc", () => {
		const doc = emptyDoc();
		produce(doc, (d) => {
			applyMutation(d, { kind: "setAppName", name: "Renamed" });
		});
		expect(doc.appName).toBe("Original");
	});
});

describe("applyMutation: setConnectType", () => {
	it("sets learn", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setConnectType", connectType: "learn" });
		});
		expect(next.connectType).toBe("learn");
	});

	it("sets null to disable connect", () => {
		const withLearn: BlueprintDoc = { ...emptyDoc(), connectType: "learn" };
		const next = produce(withLearn, (d) => {
			applyMutation(d, { kind: "setConnectType", connectType: null });
		});
		expect(next.connectType).toBeNull();
	});
});

describe("applyMutation: setCaseTypes", () => {
	it("sets a case type list", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, {
				kind: "setCaseTypes",
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "name", label: "Name" }],
					},
				],
			});
		});
		expect(next.caseTypes).toEqual([
			{
				name: "patient",
				properties: [{ name: "name", label: "Name" }],
			},
		]);
	});

	it("sets null", () => {
		const withTypes: BlueprintDoc = {
			...emptyDoc(),
			caseTypes: [{ name: "a", properties: [] }],
		};
		const next = produce(withTypes, (d) => {
			applyMutation(d, { kind: "setCaseTypes", caseTypes: null });
		});
		expect(next.caseTypes).toBeNull();
	});
});
