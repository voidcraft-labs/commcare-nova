import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Expression } from "@/lib/domain/expression/types";
import { asUuid } from "@/lib/domain/uuid";
import { expandDoc } from "../expander";
import { buildCaseReferencesLoad } from "../formActions";
import { hqLoadReference } from "../hashtags";

describe("hqLoadReference", () => {
	const depths = new Map([
		["pregnancy", 0],
		["mother", 1],
		["household", 2],
		["village", 3],
	]);

	it("projects a typed read into the #case/ generation vocabulary", () => {
		expect(hqLoadReference("pregnancy", "ga", depths)).toBe("#case/ga");
		expect(hqLoadReference("mother", "code", depths)).toBe("#case/parent/code");
		expect(hqLoadReference("household", "head", depths)).toBe(
			"#case/grandparent/head",
		);
	});

	it("falls back to a parent chain past the named generations", () => {
		expect(hqLoadReference("village", "name", depths)).toBe(
			"#case/parent/parent/parent/name",
		);
	});

	it("gives no entry for a type the form does not reach", () => {
		expect(hqLoadReference("unknown", "x", depths)).toBeUndefined();
	});
});

/** A follow-up form over `ownType`, whose parent type is `parentType`, reading
 * `code` from both and one worker property, and, unless `admitted`, a type it
 * does not reach, which the gate refuses and the export cannot print. */
function followupReading(
	ownType: string,
	parentType: string,
	admitted = false,
) {
	const workerProperty = asUuid("22222222-2222-4222-8222-222222222222");
	const read = (caseType: string): Expression => ({
		kind: "term",
		term: { kind: "form-case", caseType, property: "code" },
	});
	const original = buildDoc({
		caseTypes: [
			{
				name: ownType,
				parent_type: parentType,
				properties: [{ name: "code", label: "Code" }],
			},
			{ name: parentType, properties: [{ name: "code", label: "Code" }] },
			{ name: "elsewhere", properties: [{ name: "code", label: "Code" }] },
		],
		modules: [
			{
				name: "Records",
				caseType: ownType,
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "own",
								calculate: read(ownType),
							}),
							f({
								kind: "hidden",
								id: "parent",
								calculate: read(parentType),
							}),
							...(admitted
								? []
								: [
										f({
											kind: "hidden",
											id: "unreached",
											calculate: read("elsewhere"),
										}),
									]),
							f({
								kind: "hidden",
								id: "worker",
								calculate: {
									kind: "term",
									term: {
										kind: "session-user-property",
										userPropertyUuid: workerProperty,
										source: "worker-record",
									},
								},
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
				slug: "region",
				label: "Region",
			},
		},
		userPropertyOrder: [workerProperty],
	};
	return { doc, formUuid: doc.formOrder[doc.moduleOrder[0]][0] };
}

describe("case types named for a reference word", () => {
	const words = ["case", "user", "search", "form", "row", "record"] as const;
	for (const [index, ownType] of words.entries()) {
		const parentType = words[(index + 1) % words.length];
		it(`records a ${ownType} follow-up's reads as case reads, its ${parentType} parent included`, () => {
			const { doc, formUuid } = followupReading(ownType, parentType);
			const load = {
				"/data/own": ["#case/code"],
				"/data/parent": ["#case/parent/code"],
				"/data/worker": ["#user/region"],
			};
			expect(
				buildCaseReferencesLoad(doc, formUuid, undefined, ownType),
			).toEqual(load);
			/* The HQ JSON form carries the same map, built over the menu's own
			 * case type. */
			const admitted = followupReading(ownType, parentType, true).doc;
			expect(
				expandDoc(admitted).modules[0].forms[0].case_references_data?.load,
			).toEqual(load);
		});
	}
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
