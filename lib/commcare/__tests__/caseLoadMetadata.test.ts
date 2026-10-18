import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Expression } from "@/lib/domain/expression/types";
import { asUuid } from "@/lib/domain/uuid";
import { buildCaseReferencesLoad } from "../formActions";
import { hqLoadReference } from "../hashtags";

describe("hqLoadReference", () => {
	const depths = new Map([
		["pregnancy", 0],
		["mother", 1],
		["household", 2],
		["village", 3],
	]);

	it("translates per-type refs to the #case/ generation vocabulary", () => {
		expect(hqLoadReference("#pregnancy/ga", depths)).toBe("#case/ga");
		expect(hqLoadReference("#mother/code", depths)).toBe("#case/parent/code");
		expect(hqLoadReference("#household/head", depths)).toBe(
			"#case/grandparent/head",
		);
	});

	it("falls back to a parent chain past the named generations", () => {
		expect(hqLoadReference("#village/name", depths)).toBe(
			"#case/parent/parent/parent/name",
		);
	});

	it("rejects authored #case/ and passes #user/ plus unreachable namespaces through", () => {
		expect(() => hqLoadReference("#case/ga", depths)).toThrow(
			'Authored "#case/..." is not a Nova reference',
		);
		expect(hqLoadReference("#user/role", depths)).toBe("#user/role");
		expect(hqLoadReference("#unknown/x", depths)).toBe("#unknown/x");
	});
});

it("derives HQ load metadata from typed case and worker-record reads only", () => {
	const workerProperty = asUuid("11111111-1111-4111-8111-111111111111");
	const expression: Expression = {
		kind: "concat",
		parts: [
			{
				kind: "term",
				term: { kind: "literal", value: "#patient/fake #user/fake" },
			},
			...["patient", "mother", "household", "village", "patient"].map(
				(caseType): Expression => ({
					kind: "term",
					term: { kind: "form-case", caseType, property: "code" },
				}),
			),
			{
				kind: "term",
				term: {
					kind: "session-user-property",
					userPropertyUuid: workerProperty,
					source: "worker-record",
				},
			},
			{ kind: "term", term: { kind: "session-user", field: "username" } },
			{ kind: "term", term: { kind: "session-context", field: "userid" } },
			{
				kind: "term",
				term: {
					kind: "session-user",
					field: "username",
					source: "worker-record",
				},
			},
		],
	};
	const original = buildDoc({
		caseTypes: [
			{
				name: "patient",
				parent_type: "mother",
				properties: [{ name: "code", label: "Code" }],
			},
			{
				name: "mother",
				parent_type: "household",
				properties: [{ name: "code", label: "Code" }],
			},
			{
				name: "household",
				parent_type: "village",
				properties: [{ name: "code", label: "Code" }],
			},
			{ name: "village", properties: [{ name: "code", label: "Code" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "group",
								id: "page",
								children: [
									f({ kind: "hidden", id: "code", calculate: expression }),
								],
							}),
						],
					},
				],
			},
		],
	});
	const doc = {
		...original,
		userProperties: {
			[workerProperty]: {
				uuid: workerProperty,
				slug: "renamed_region",
				label: "Region",
			},
		},
		userPropertyOrder: [workerProperty],
	};
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	expect(
		buildCaseReferencesLoad(
			doc,
			formUuid,
			{ deliver_unit: { id: "visit", name: "Visit" } },
			"patient",
		),
	).toEqual({
		"/data/page/code": [
			"#case/code",
			"#case/parent/code",
			"#case/grandparent/code",
			"#case/parent/parent/parent/code",
			"#user/renamed_region",
			"#user/username",
		],
		"/data/visit/deliver/entity_id": ["#user/username"],
		"/data/visit/deliver/entity_name": ["#user/username"],
	});
});

it("omits a registration's allocated case id from database-load metadata", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "hidden",
								id: "tracking",
								calculate: {
									kind: "term",
									term: {
										kind: "form-case",
										caseType: "patient",
										property: "case_id",
									},
								},
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	expect(buildCaseReferencesLoad(doc, formUuid, undefined, "patient")).toEqual(
		{},
	);
});
