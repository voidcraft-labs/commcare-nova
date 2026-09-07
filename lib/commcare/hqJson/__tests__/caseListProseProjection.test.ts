import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	ProseProjectionError,
	proseText,
} from "@/lib/domain";

describe("case-list HQ JSON prose projection", () => {
	it("fails closed when an option label identity cannot resolve", () => {
		const missingPropertyUuid = testUuid("hq-missing-worker-property");
		const doc = buildDoc({
			appName: "Projection",
			modules: [
				{
					name: "Cases",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "priority", header: "Priority" },
					]),
					forms: [
						{
							name: "Register",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "priority",
									label: proseText("Priority"),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
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
		doc.userProperties = {
			[missingPropertyUuid]: {
				uuid: missingPropertyUuid,
				slug: "priority_label",
				label: "Priority label",
			},
		};
		doc.userPropertyOrder = [missingPropertyUuid];
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const module = doc.modules[doc.moduleOrder[0]];

		expect(() => projectCaseListForHq(module, doc)).not.toThrow();
		delete doc.userProperties[missingPropertyUuid];
		expect(() => projectCaseListForHq(module, doc)).toThrow(
			ProseProjectionError,
		);
	});
});
