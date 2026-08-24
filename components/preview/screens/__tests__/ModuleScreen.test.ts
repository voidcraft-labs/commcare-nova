import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Location } from "@/lib/routing/types";
import { previewParentCaseResumeLocation } from "../ModuleScreen";

const MODULE_UUID = testUuid("parent-case-resume-module");
const FORM_UUID = testUuid("parent-case-resume-form");
const FIELD_UUID = testUuid("parent-case-resume-field");

describe("previewParentCaseResumeLocation", () => {
	it.each<Location>([
		{
			kind: "form",
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
			selectedUuid: FIELD_UUID,
		},
		{
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: "requested-case",
		},
	])("preserves the exact $kind leaf", (location) => {
		expect(previewParentCaseResumeLocation(location, MODULE_UUID)).toBe(
			location,
		);
	});

	it("does not turn an ordinary module menu into a resumable leaf", () => {
		expect(
			previewParentCaseResumeLocation(
				{ kind: "module", moduleUuid: MODULE_UUID },
				MODULE_UUID,
			),
		).toBeUndefined();
	});

	it("does not resume a leaf owned by another module", () => {
		expect(
			previewParentCaseResumeLocation(
				{
					kind: "form",
					moduleUuid: testUuid("another-module"),
					formUuid: FORM_UUID,
				},
				MODULE_UUID,
			),
		).toBeUndefined();
	});
});
