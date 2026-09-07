import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type PreviewScreen, screenKey } from "../types";

const MODULE = testUuid("module");
const FORM = testUuid("form");

describe("PreviewScreen mounted-view identity", () => {
	it("separates every screen kind and distinct entity destination", () => {
		const screens: PreviewScreen[] = [
			{ type: "home" },
			{ type: "projectData" },
			{ type: "projectData", tableId: testUuid("table") },
			{ type: "module", moduleUuid: MODULE },
			{ type: "module", moduleUuid: testUuid("other-module") },
			{ type: "caseList", moduleUuid: MODULE },
			{ type: "searchConfig", moduleUuid: MODULE },
			{ type: "detailConfig", moduleUuid: MODULE },
			{ type: "dataReview", moduleUuid: MODULE },
			{ type: "appSetup", section: "users" },
			{ type: "form", moduleUuid: MODULE, formUuid: FORM },
			{ type: "form", moduleUuid: MODULE, formUuid: testUuid("other-form") },
		];
		expect(new Set(screens.map(screenKey)).size).toBe(screens.length);
	});

	it("keeps the same form mounted when its selected cases change", () => {
		const form = { type: "form", moduleUuid: MODULE, formUuid: FORM } as const;
		expect(
			screenKey({ ...form, cases: [{ caseId: "one", caseName: "One" }] }),
		).toBe(screenKey({ ...form, cases: [{ caseId: "two", caseName: "Two" }] }));
	});
});
