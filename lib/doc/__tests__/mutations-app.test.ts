import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/doc/types";
import { proseText } from "@/lib/domain/prose";

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

describe("applyMutation: granular case-type catalog", () => {
	it("declares a type and adds a property without a whole-catalog mutation", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "declareCaseType", caseType: "patient" });
			applyMutation(d, {
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "name", label: proseText("Name") },
			});
		});
		expect(next.caseTypes).toEqual([
			{
				name: "patient",
				properties: [{ name: "name", label: proseText("Name") }],
			},
		]);
	});

	it("retiring the last type restores the canonical null catalog", () => {
		const withTypes: BlueprintDoc = {
			...emptyDoc(),
			caseTypes: [{ name: "a", properties: [] }],
		};
		const next = produce(withTypes, (d) => {
			applyMutation(d, { kind: "retireCaseType", caseType: "a" });
		});
		expect(next.caseTypes).toBeNull();
	});
});

describe("applyMutation: setAppLogo", () => {
	it("sets the logo to an asset id", () => {
		const logo = testMediaAssetId("asset-logo");
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setAppLogo", logo });
		});
		expect(next.logo).toBe(logo);
	});

	it("clears the logo by mapping null to undefined (not a literal null)", () => {
		const withLogo: BlueprintDoc = {
			...emptyDoc(),
			logo: testMediaAssetId("asset-logo"),
		};
		const next = produce(withLogo, (d) => {
			applyMutation(d, { kind: "setAppLogo", logo: null });
		});
		// `logo` is `.optional()` on the doc schema — a cleared logo must
		// drop to `undefined`, never persist as `null` (which the schema
		// would reject on the next round-trip).
		expect(next.logo).toBeUndefined();
	});

	it("does not mutate the input doc", () => {
		const doc = emptyDoc();
		produce(doc, (d) => {
			applyMutation(d, {
				kind: "setAppLogo",
				logo: testMediaAssetId("asset-logo"),
			});
		});
		expect(doc.logo).toBeUndefined();
	});
});
