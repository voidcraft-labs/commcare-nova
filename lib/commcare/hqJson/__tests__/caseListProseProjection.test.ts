import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import { ProseProjectionError, proseText } from "@/lib/domain";

describe("case-list HQ JSON prose projection", () => {
	it("fails closed when an option label identity cannot resolve", () => {
		const missingPropertyUuid = testUuid("hq-missing-worker-property");
		const doc = buildDoc({
			appName: "Projection",
			modules: [
				{
					name: "Cases",
					caseType: "case",
					caseListConfig: caseListConfig([
						{ field: "priority", header: "Priority" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "priority",
									label: proseText("Priority"),
									case_property_on: "case",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "case",
					properties: [
						{
							name: "priority",
							label: proseText("Priority"),
							data_type: "single_select",
							options: [
								{
									value: "urgent",
									label: {
										parts: [
											{
												kind: "user-property-ref",
												userPropertyUuid: missingPropertyUuid,
											},
										],
									},
								},
							],
						},
					],
				},
			],
		});
		const module = doc.modules[doc.moduleOrder[0]];

		expect(() => projectCaseListForHq(module, doc)).toThrow(
			ProseProjectionError,
		);
	});
});
