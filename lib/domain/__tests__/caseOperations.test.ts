import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid } from "@/lib/doc/types";
import {
	caseOperationSchema,
	effectiveCaseTypes,
	type Form,
	MAX_CASE_OPERATION_TEXT_LENGTH,
	materializableCaseTypes,
	orderedCaseOperations,
	planCaseRetype,
	prepareCaseOperationTextValue,
} from "@/lib/domain";
import {
	actingUser,
	literal,
	prop,
	term,
	unowned,
} from "@/lib/domain/predicate";

const A = asUuid("11111111-1111-4111-8111-111111111111");
const B = asUuid("22222222-2222-4222-8222-222222222222");

describe("case-operation domain vocabulary", () => {
	it("normalizes and bounds case name/owner facets with Java-compatible whitespace", () => {
		expect(prepareCaseOperationTextValue("\t Alice  Smith \r\n")).toEqual({
			ok: true,
			value: "Alice  Smith",
		});
		expect(prepareCaseOperationTextValue(" \t\n\v\f\r ")).toEqual({
			ok: false,
			value: "",
			reason: "blank",
		});
		expect(
			prepareCaseOperationTextValue("x".repeat(MAX_CASE_OPERATION_TEXT_LENGTH)),
		).toMatchObject({ ok: true });
		expect(
			prepareCaseOperationTextValue(
				`  ${"x".repeat(MAX_CASE_OPERATION_TEXT_LENGTH)}  `,
			),
		).toMatchObject({ ok: true });
		expect(
			prepareCaseOperationTextValue(
				"x".repeat(MAX_CASE_OPERATION_TEXT_LENGTH + 1),
			),
		).toMatchObject({ ok: false, reason: "too-long" });
		// Java regex's default `\\s` does not include NBSP. Keep that exact
		// rather than silently adopting JavaScript's broader `\\s` semantics.
		expect(prepareCaseOperationTextValue("\u00a0name\u00a0")).toMatchObject({
			ok: true,
			value: "\u00a0name\u00a0",
		});
	});

	it("parses typed targets and retains authored create ids", () => {
		const parsed = caseOperationSchema.parse({
			uuid: A,
			id: "create_visit",
			order: "a0",
			action: "create",
			caseType: "visit",
			target: { kind: "new", idFrom: B },
			name: term(literal("Visit")),
			owner: actingUser(),
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target: { kind: "op", opUuid: B },
					relationship: "extension",
				},
			],
		});
		expect(parsed.target).toEqual({ kind: "new", idFrom: B });
		expect(parsed.owner).toEqual({ kind: "acting-user" });
		expect(parsed.links?.[0].target).toEqual({ kind: "op", opUuid: B });
		expect(
			caseOperationSchema.parse({
				...parsed,
				uuid: B,
				id: "create_unowned_visit",
				owner: unowned(),
			}).owner,
		).toEqual({ kind: "unowned" });
	});

	it("orders by fractional key and then immutable UUID", () => {
		const base = {
			id: "op",
			action: "update" as const,
			caseType: "patient",
			target: { kind: "session" as const },
		};
		const ordered = orderedCaseOperations({
			caseOperations: [
				{ ...base, uuid: B, order: "b" },
				{ ...base, uuid: B, id: "second_a", order: "a" },
				{ ...base, uuid: A, id: "first_a", order: "a" },
			],
		});
		expect(ordered.map((operation) => operation.id)).toEqual([
			"first_a",
			"second_a",
			"op",
		]);
	});

	it("includes operation writers in effective and materialized case schemas", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "score", label: "Score" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Edit", type: "followup" }],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: A,
				id: "score_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "score", value: term(literal(7)) }],
			},
		];

		expect(
			effectiveCaseTypes(doc)[0].properties.find(
				(property) => property.name === "score",
			)?.data_type,
		).toBe("int");
		expect(
			materializableCaseTypes(doc)[0].properties.find(
				(property) => property.name === "score",
			)?.data_type,
		).toBe("int");
	});

	it("infers operation writes in the containing form context, not the target type", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "score", label: "Score" }],
				},
				{
					name: "visit",
					properties: [{ name: "patient_score", label: "Patient score" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Edit",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "score",
									label: "Score",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: A,
				id: "create_visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: term(literal("Visit")),
				writes: [
					{
						property: "patient_score",
						value: term({
							kind: "prop",
							caseType: "patient",
							property: "score",
						}),
					},
				],
			},
		];

		expect(
			effectiveCaseTypes(doc)
				.find((caseType) => caseType.name === "visit")
				?.properties.find((property) => property.name === "patient_score")
				?.data_type,
		).toBe("int");
	});

	it("reaches a fixed point when one operation copies another writer-derived property", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "score", label: "Score" },
						{ name: "score_copy", label: "Score copy" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Edit", type: "followup" }],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: A,
				id: "copy_score",
				order: "a",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "score_copy",
						value: term({
							kind: "prop",
							caseType: "patient",
							property: "score",
						}),
					},
				],
			},
			{
				uuid: B,
				id: "write_score",
				order: "b",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "score", value: term(literal(7)) }],
			},
		];

		const properties = new Map(
			effectiveCaseTypes(doc)[0].properties.map((property) => [
				property.name,
				property.data_type,
			]),
		);
		expect(properties.get("score")).toBe("int");
		expect(properties.get("score_copy")).toBe("int");
	});

	it("keeps a mutual operation-writer copy cycle honestly untyped", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "left", label: "Left" },
						{ name: "right", label: "Right" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Edit", type: "followup" }],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: asUuid("33333333-3333-4333-8333-333333333333"),
				id: "copy_right_to_left",
				order: "a",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "left",
						value: term(prop("patient", "right")),
					},
				],
			},
			{
				uuid: asUuid("44444444-4444-4444-8444-444444444444"),
				id: "copy_left_to_right",
				order: "b",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "right",
						value: term(prop("patient", "left")),
					},
				],
			},
		];

		const properties = new Map(
			effectiveCaseTypes(doc)
				.find((caseType) => caseType.name === "patient")
				?.properties.map((property) => [property.name, property.data_type]),
		);
		expect(properties.get("left")).toBeUndefined();
		expect(properties.get("right")).toBeUndefined();
	});
});

describe("case retype planning", () => {
	it("pins conversion, parking, and required-value review before activation", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "lead",
					properties: [
						{ name: "shared", label: "Shared", data_type: "text" },
						{ name: "legacy", label: "Legacy", data_type: "text" },
						{ name: "case_name", label: "Legacy declared case name" },
					],
				},
				{
					name: "client",
					properties: [
						{ name: "shared", label: "Shared", data_type: "int" },
						{
							name: "enrolled",
							label: "Enrolled",
							required: "true()",
						},
					],
				},
			],
		});

		const blocked = planCaseRetype(doc, "lead", "client");
		expect(blocked.conversions).toEqual([
			{
				property: "shared",
				fromType: "text",
				toType: "int",
				canPark: true,
			},
		]);
		expect(blocked.parked).toEqual(["legacy"]);
		expect(blocked.parked).not.toContain("case_name");
		expect(blocked.missingRequired).toEqual(["enrolled"]);
		expect(blocked.reviewRequired).toBe(true);
		expect(blocked.safe).toBe(false);
		expect(blocked.wirePortable).toBe(false);

		const completed = planCaseRetype(
			doc,
			"lead",
			"client",
			new Set(["enrolled"]),
		);
		expect(completed.missingRequired).toEqual([]);
		expect(completed.safe).toBe(true);
		expect(completed.wirePortable).toBe(false);

		const sameSchema = planCaseRetype(doc, "lead", "lead");
		expect(sameSchema.retained).toEqual(["shared", "legacy"]);
		expect(sameSchema.retained).not.toContain("case_name");
		expect(sameSchema.wirePortable).toBe(true);
	});
});
