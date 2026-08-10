import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { analyzeBlueprint } from "../blueprint-stats";

const MODULE = testUuid("61000000-0000-4000-8000-000000000000");
const FORM = testUuid("62000000-0000-4000-8000-000000000000");
const FIELD = testUuid("63000000-0000-4000-8000-000000000000");
const COLUMN = testUuid("64000000-0000-4000-8000-000000000000");
const OPERATION = testUuid("65000000-0000-4000-8000-000000000000");

function fixture(property: string): BlueprintDoc {
	return {
		appId: "stats-app",
		appName: "Stats",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: ["case_name", "nickname"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
			},
		],
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						{
							uuid: COLUMN,
							kind: "plain",
							field: "case_name",
							header: "Name",
						},
					],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
				},
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "register",
				name: "Register",
				type: "registration",
			},
		},
		fields: {
			[FIELD]: {
				uuid: FIELD,
				id: "case_name",
				kind: "text",
				label: proseText("Full name"),
				caseWrite: { caseType: "patient", property },
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: { [FIELD]: FORM },
	};
}

describe("blueprint stats case-write quality", () => {
	it("accepts a friendly field id when its own-type destination is case_name", () => {
		const doc = fixture("case_name");
		doc.fields[FIELD].id = "full_name";

		const stats = analyzeBlueprint(doc);

		expect(stats.modules[0]?.forms[0]?.casePropertyCount).toBe(1);
		expect(
			stats.qualityFlags.some((flag) =>
				flag.message.includes("no field writing case_name"),
			),
		).toBe(false);
	});

	it("does not mistake the field id case_name for a name writer", () => {
		const stats = analyzeBlueprint(fixture("nickname"));

		expect(stats.qualityFlags).toContainEqual(
			expect.objectContaining({
				severity: "error",
				message:
					"Registration form has no field writing case_name to its own case type — case will have no name",
			}),
		);
	});

	it("recognizes an advanced case operation as persisted form work", () => {
		const doc = fixture("nickname");
		const field = doc.fields[FIELD];
		if (field === undefined || !("caseWrite" in field)) {
			throw new Error("fixture field supports case writes");
		}
		delete field.caseWrite;
		doc.forms[FORM] = {
			...doc.forms[FORM],
			type: "followup",
			caseOperations: [
				{
					uuid: OPERATION,
					id: "create_visit",
					action: "create",
					caseType: "patient",
					target: { kind: "new" },
					name: {
						kind: "term",
						term: { kind: "literal", value: "Visit", data_type: "text" },
					},
				},
			],
		};

		const stats = analyzeBlueprint(doc);

		expect(stats.modules[0]?.forms[0]).toMatchObject({
			casePropertyCount: 0,
			caseOperationCount: 1,
		});
		expect(
			stats.qualityFlags.some((flag) =>
				flag.message.includes("saves nothing to the case"),
			),
		).toBe(false);
	});
});
