import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { caseDatabaseRequirements } from "../useCaseDatabaseSnapshot";

const MODULE_UUID = testUuid("source-module");

describe("caseDatabaseRequirements", () => {
	it("loads casedb when a form references only a structural case hashtag", () => {
		const doc = buildDoc({
			appName: "Case hashtags",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "status",
							label: { parts: [{ kind: "text", text: "Status" }] },
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Follow up",
							type: "followup",
							fields: [
								{
									id: "copied_status",
									kind: "hidden",
									calculate: "#patient/status",
								},
							],
						},
					],
				},
			],
		});

		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
		});
	});

	it("loads casedb when only a post-submit carrier references it", () => {
		const doc = buildDoc({
			appName: "Links",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "source-module",
					name: "Source",
					caseType: "patient",
					forms: [
						{
							uuid: "source-form",
							name: "Source",
							type: "survey",
							formLinks: [
								{
									uuid: "source-link",
									condition: "count(instance('casedb')/casedb/case) > 0",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
							],
							fields: [],
						},
					],
				},
			],
		});

		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
		});
	});

	it("loads casedb for a case-bearing link without an explicit casedb expression", () => {
		const doc = buildDoc({
			appName: "Carried cases",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "source-module",
					name: "Source",
					caseType: "patient",
					forms: [
						{
							uuid: "source-form",
							name: "Source",
							type: "followup",
							formLinks: [
								{
									uuid: "source-link",
									condition: "true()",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
							],
							fields: [],
						},
					],
				},
			],
		});

		expect(caseDatabaseRequirements(doc)).toEqual({
			required: true,
			caseTypes: ["commcare-user", "patient"],
		});
	});

	it("does not load casedb for links in an all-survey app", () => {
		const doc = buildDoc({
			appName: "Survey links",
			modules: [
				{
					uuid: "source-module",
					name: "Source",
					forms: [
						{
							uuid: "source-form",
							name: "Source",
							type: "survey",
							formLinks: [
								{
									uuid: "source-link",
									condition: "true()",
									target: { type: "module", moduleUuid: MODULE_UUID },
								},
							],
							fields: [],
						},
					],
				},
			],
		});

		expect(caseDatabaseRequirements(doc)).toEqual({
			required: false,
			caseTypes: [],
		});
	});
});
