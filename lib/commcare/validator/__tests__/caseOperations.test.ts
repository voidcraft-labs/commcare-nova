import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { LookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { validateCaseOperations } from "@/lib/commcare/validator/rules/caseOperations";
import { asUuid } from "@/lib/doc/types";
import type { BlueprintDoc, CaseOperation, Form, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	actingUser,
	concat,
	dateAdd,
	double,
	eq,
	exists,
	formField,
	idOf,
	ifExpr,
	literal,
	prop,
	subcasePath,
	tableLookup,
	term,
	today,
	unowned,
	unwrapList,
} from "@/lib/domain/predicate";
import type { ValidationErrorCode } from "../errors";

const CREATE = asUuid("11111111-1111-4111-8111-111111111111");
const SECOND = asUuid("22222222-2222-4222-8222-222222222222");
const THIRD = asUuid("33333333-3333-4333-8333-333333333333");
const TEXT = asUuid("44444444-4444-4444-8444-444444444444");
const NUMBER = asUuid("55555555-5555-4555-8555-555555555555");
const REPEAT_A = asUuid("66666666-6666-4666-8666-666666666666");
const REPEAT_A_TEXT = asUuid("77777777-7777-4777-8777-777777777777");
const REPEAT_B = asUuid("88888888-8888-4888-8888-888888888888");
const REPEAT_B_TEXT = asUuid("99999999-9999-4999-8999-999999999999");
const HIDDEN_ID = asUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const MULTI = asUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const REPEAT_CHILD = asUuid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const REPEAT_CHILD_TEXT = asUuid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
const REPEAT_SIBLING = asUuid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
const REPEAT_SIBLING_TEXT = asUuid("ffffffff-ffff-4fff-8fff-ffffffffffff");
const LOOKUP_TABLE = "00000000-0000-7000-8000-0000000000a1" as LookupTableId;
const LOOKUP_COLUMN = "10000000-0000-7000-8000-0000000000a1" as LookupColumnId;
const LOOKUP_TYPES: LookupTypeIndex = new Map([
	[LOOKUP_TABLE, new Map([[LOOKUP_COLUMN, "text"]])],
]);

interface Fixture {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}

function fixture(
	formType: "followup" | "registration" | "close" = "followup",
): Fixture {
	const reservedProperties = [
		"case_id",
		"case_name",
		"case_type",
		"date_modified",
		"date_opened",
		"owner_id",
		"location_id",
		"hq_user_id",
		"external_id",
		"category",
		"state",
	];
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: "Nickname", data_type: "text" },
					{ name: "score", label: "Score", data_type: "int" },
					{ name: "weight", label: "Weight", data_type: "decimal" },
					{ name: "tags", label: "Tags", data_type: "multi_select" },
					{ name: "mixed", label: "Mixed" },
					{ name: "not-wire-safe", label: "Not wire safe" },
					...reservedProperties.map((name) => ({ name, label: name })),
				],
			},
			{
				name: "visit",
				properties: [{ name: "source_id", label: "Source ID" }],
			},
			{
				name: "lead",
				properties: [{ name: "legacy", label: "Legacy" }],
			},
			{
				name: "lead_copy",
				properties: [{ name: "legacy", label: "Legacy" }],
			},
			{
				name: "client",
				properties: [
					{ name: "enrolled", label: "Enrolled", required: "true()" },
				],
			},
			{ name: "commcare-user", properties: [] },
			{ name: "commcare-case-claim", properties: [] },
			{ name: "user-owner-mapping-case", properties: [] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Edit",
						type: formType,
						fields: [
							f({ uuid: TEXT, kind: "text", id: "text", label: "Text" }),
							f({ uuid: NUMBER, kind: "int", id: "number", label: "Number" }),
							f({
								uuid: HIDDEN_ID,
								kind: "hidden",
								id: "created_case_id",
								default_value: "uuid()",
							}),
							f({
								uuid: MULTI,
								kind: "multi_select",
								id: "choices",
								label: "Choices",
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}),
							f({
								uuid: REPEAT_A,
								kind: "repeat",
								id: "rows_a",
								label: "Rows A",
								repeat_mode: "user_controlled",
								children: [
									f({
										uuid: REPEAT_A_TEXT,
										kind: "text",
										id: "row_a_text",
										label: "Row A text",
									}),
								],
							}),
							f({
								uuid: REPEAT_B,
								kind: "repeat",
								id: "rows_b",
								label: "Rows B",
								repeat_mode: "user_controlled",
								children: [
									f({
										uuid: REPEAT_B_TEXT,
										kind: "text",
										id: "row_b_text",
										label: "Row B text",
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
}

function nestedRepeatFixture(): Fixture {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Edit",
						type: "followup",
						fields: [
							f({ uuid: TEXT, kind: "text", id: "root", label: "Root" }),
							f({
								uuid: REPEAT_A,
								kind: "repeat",
								id: "outer",
								label: "Outer",
								children: [
									f({
										uuid: REPEAT_A_TEXT,
										kind: "text",
										id: "outer_text",
										label: "Outer text",
									}),
									f({
										uuid: REPEAT_B,
										kind: "repeat",
										id: "inner",
										label: "Inner",
										children: [
											f({
												uuid: REPEAT_B_TEXT,
												kind: "text",
												id: "inner_text",
												label: "Inner text",
											}),
											f({
												uuid: REPEAT_CHILD,
												kind: "repeat",
												id: "child",
												label: "Child",
												children: [
													f({
														uuid: REPEAT_CHILD_TEXT,
														kind: "text",
														id: "child_text",
														label: "Child text",
													}),
												],
											}),
										],
									}),
									f({
										uuid: REPEAT_SIBLING,
										kind: "repeat",
										id: "sibling",
										label: "Sibling",
										children: [
											f({
												uuid: REPEAT_SIBLING_TEXT,
												kind: "text",
												id: "sibling_text",
												label: "Sibling text",
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
}

function create(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: CREATE,
		id: "create_visit",
		order: "a",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(literal("Visit")),
		...patch,
	};
}

function update(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: SECOND,
		id: "update_patient",
		order: "b",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		...patch,
	};
}

function errorsFor(
	operations: readonly CaseOperation[],
	formType: "followup" | "registration" | "close" = "followup",
): ReturnType<typeof validateCaseOperations> {
	const built = fixture(formType);
	(built.doc.forms[built.formUuid] as Form).caseOperations = [...operations];
	return validateCaseOperations(built.doc, built.formUuid, built.moduleUuid);
}

function codesFor(
	operations: readonly CaseOperation[],
	formType: "followup" | "registration" | "close" = "followup",
): ValidationErrorCode[] {
	return errorsFor(operations, formType).map((error) => error.code);
}

function expectCode(
	code: ValidationErrorCode,
	operations: readonly CaseOperation[],
	formType: "followup" | "registration" | "close" = "followup",
): void {
	expect(codesFor(operations, formType)).toContain(code);
}

function mapFieldToCaseType(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	id: string,
	caseType: string,
): void {
	const field = doc.fields[fieldUuid] as unknown as {
		id: string;
		case_property_on?: string;
	};
	field.id = id;
	field.case_property_on = caseType;
}

describe("case-operation activation and identity", () => {
	it("keeps every otherwise-valid operation commit-gated until runtime activation", () => {
		expect(codesFor([update()])).toEqual(["CASE_OPERATIONS_NOT_ACTIVE"]);
		expect(codesFor([update({ owner: actingUser() })])).toEqual([
			"CASE_OPERATIONS_NOT_ACTIVE",
		]);
		expect(codesFor([update({ owner: unowned() })])).toEqual([
			"CASE_OPERATIONS_NOT_ACTIVE",
		]);
	});

	it("rejects duplicate UUIDs, duplicate ids, and unsafe wire ids", () => {
		expectCode("CASE_OPERATION_DUPLICATE_UUID", [
			create(),
			update({ uuid: CREATE }),
		]);
		expectCode("CASE_OPERATION_DUPLICATE_ID", [
			create(),
			update({ id: "create_visit" }),
		]);
		expectCode("CASE_OPERATION_INVALID_ID", [update({ id: "__nova_bad" })]);
	});

	it("keeps repeated operations on an explicit in-form repeat", () => {
		expectCode("CASE_OPERATION_REPEAT_INVALID", [
			update({ forEach: { repeat: TEXT } }),
		]);
		expectCode("CASE_OPERATION_REPEAT_INVALID", [
			update({ forEach: { repeat: THIRD } }),
		]);
	});

	it("rejects authored order that the repeat-shaped wire tree cannot preserve", () => {
		expect(
			codesFor([
				update({
					uuid: THIRD,
					id: "update_each_row",
					order: "a",
					forEach: { repeat: REPEAT_A },
				}),
				update({ order: "b" }),
			]),
		).toEqual(
			expect.arrayContaining([
				"CASE_OPERATIONS_NOT_ACTIVE",
				"CASE_OPERATION_EXECUTION_ORDER",
			]),
		);

		expect(
			codesFor([
				update({
					uuid: THIRD,
					id: "update_rows_b",
					order: "a",
					forEach: { repeat: REPEAT_B },
				}),
				update({ order: "b", forEach: { repeat: REPEAT_A } }),
			]),
		).toContain("CASE_OPERATION_EXECUTION_ORDER");

		expectCode("CASE_OPERATION_EXECUTION_ORDER", [
			update({ order: "a" }),
			create({ order: "b", target: { kind: "new", idFrom: TEXT } }),
		]);

		expectCode("CASE_OPERATION_EXECUTION_ORDER", [
			create({
				forEach: { repeat: REPEAT_A },
				target: { kind: "new", idFrom: REPEAT_A_TEXT },
			}),
			update({
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
				forEach: { repeat: REPEAT_A },
			}),
		]);

		// The raw key cannot equal Nova's namespaced derived case id, so a
		// same-repeat operation targeting that raw answer is order-independent.
		expect(
			codesFor([
				create({
					forEach: { repeat: REPEAT_A },
					target: { kind: "new", idFrom: REPEAT_A_TEXT },
				}),
				update({
					caseType: "visit",
					target: {
						kind: "expression",
						expr: term(formField(REPEAT_A_TEXT)),
					},
					forEach: { repeat: REPEAT_A },
				}),
			]),
		).not.toContain("CASE_OPERATION_EXECUTION_ORDER");

		const siblingScopes = fixture();
		(siblingScopes.doc.forms[siblingScopes.formUuid] as Form).caseOperations = [
			create({
				forEach: { repeat: REPEAT_A },
				target: { kind: "new", idFrom: REPEAT_A_TEXT },
			}),
			update({
				caseType: "visit",
				target: {
					kind: "expression",
					expr: term(literal("nova-case-v1:possible-existing-id")),
				},
				forEach: { repeat: REPEAT_B },
			}),
		];
		expect(
			validateCaseOperations(
				siblingScopes.doc,
				siblingScopes.formUuid,
				siblingScopes.moduleUuid,
			).map((error) => error.code),
		).not.toContain("CASE_OPERATION_EXECUTION_ORDER");

		// Nested scopes share the outer repeat's runtime iteration. The inner
		// create and outer update therefore interleave again on the next outer
		// row even though their definition-level scope order is representable.
		const nestedScopes = fixture();
		nestedScopes.doc.fieldOrder[nestedScopes.formUuid] = (
			nestedScopes.doc.fieldOrder[nestedScopes.formUuid] ?? []
		).filter((uuid) => uuid !== REPEAT_B);
		nestedScopes.doc.fieldOrder[REPEAT_A] = [
			...(nestedScopes.doc.fieldOrder[REPEAT_A] ?? []),
			REPEAT_B,
		];
		(nestedScopes.doc.forms[nestedScopes.formUuid] as Form).caseOperations = [
			create({
				forEach: { repeat: REPEAT_B },
				target: { kind: "new", idFrom: REPEAT_B_TEXT },
			}),
			update({
				caseType: "visit",
				target: {
					kind: "expression",
					expr: term(literal("nova-case-v1:possible-existing-id")),
				},
				forEach: { repeat: REPEAT_A },
			}),
		];
		expect(
			validateCaseOperations(
				nestedScopes.doc,
				nestedScopes.formUuid,
				nestedScopes.moduleUuid,
			).map((error) => error.code),
		).toContain("CASE_OPERATION_EXECUTION_ORDER");
	});
});

describe("case-operation action, catalog, and reserved vocabulary", () => {
	it("rejects facets that do not belong to the selected action", () => {
		expectCode("CASE_OPERATION_INVALID_FACETS", [
			create({ target: { kind: "session" } }),
		]);
		expectCode("CASE_OPERATION_INVALID_FACETS", [
			update({ target: { kind: "new" }, name: term(literal("No")) }),
		]);
		expectCode("CASE_OPERATION_INVALID_FACETS", [
			update({ action: "close", owner: term(literal("owner")) }),
		]);
	});

	it("rejects unknown and platform-owned case types", () => {
		expectCode("CASE_OPERATION_UNKNOWN_CASE_TYPE", [
			update({ caseType: "missing" }),
		]);
		for (const caseType of [
			"commcare-user",
			"commcare-case-claim",
			"user-owner-mapping-case",
		]) {
			expectCode("CASE_OPERATION_RESERVED_CASE_TYPE", [
				update({
					caseType,
					target: { kind: "expression", expr: term(literal("case-id")) },
				}),
			]);
		}
	});

	it("applies the wire identifier grammar and length to every operation case type", () => {
		expectCode("CASE_OPERATION_INVALID_CASE_TYPE", [
			update({ caseType: "bad type" }),
		]);
		expectCode("CASE_OPERATION_INVALID_CASE_TYPE", [
			update({ caseType: `p${"x".repeat(255)}` }),
		]);
		expectCode("CASE_OPERATION_INVALID_CASE_TYPE", [
			update({ retype: "bad type" }),
		]);
		expectCode("CASE_OPERATION_INVALID_CASE_TYPE", [
			update({
				links: [
					{
						identifier: "related",
						targetType: "bad type",
						target: null,
						relationship: "child",
					},
				],
			}),
		]);
	});

	it("rejects undeclared, duplicate, malformed, and every reserved property write", () => {
		expectCode("CASE_OPERATION_UNKNOWN_PROPERTY", [
			update({ writes: [{ property: "missing", value: term(literal("x")) }] }),
		]);
		expectCode("CASE_OPERATION_INVALID_FACETS", [
			update({
				writes: [
					{ property: "nickname", value: term(literal("a")) },
					{ property: "nickname", value: term(literal("b")) },
				],
			}),
		]);
		expectCode("CASE_OPERATION_UNKNOWN_PROPERTY", [
			update({
				writes: [{ property: "not-wire-safe", value: term(literal("x")) }],
			}),
		]);
		for (const property of [
			"case_id",
			"case_name",
			"case_type",
			"date_modified",
			"date_opened",
			"owner_id",
			"location_id",
			"hq_user_id",
			"external_id",
			"category",
			"state",
		]) {
			expectCode("CASE_OPERATION_RESERVED_PROPERTY", [
				update({ writes: [{ property, value: term(literal("x")) }] }),
			]);
		}
	});

	it("admits only wire-portable retypes after destination requirements are met", () => {
		expectCode("CASE_OPERATION_RETYPE_UNSAFE", [
			update({
				caseType: "lead",
				target: { kind: "expression", expr: term(literal("lead-id")) },
				retype: "client",
			}),
		]);
		// Supplying the required destination value makes the storage plan
		// atomic, but the source-only `legacy` value would still remain on
		// CommCare's schemaless case while Nova parks it. Keep that divergent
		// retype dormant until a shared wire representation exists.
		expectCode("CASE_OPERATION_RETYPE_UNSAFE", [
			update({
				caseType: "lead",
				target: { kind: "expression", expr: term(literal("lead-id")) },
				retype: "client",
				writes: [{ property: "enrolled", value: term(literal("yes")) }],
			}),
		]);
		expectCode("CASE_OPERATION_RETYPE_UNSAFE", [
			update({
				caseType: "lead",
				target: { kind: "expression", expr: term(literal("lead-id")) },
				retype: "client",
				writes: [
					{
						property: "enrolled",
						value: term(literal("yes")),
						condition: { kind: "match-all" },
					},
				],
			}),
		]);
		expect(
			codesFor([
				update({
					caseType: "lead",
					target: { kind: "expression", expr: term(literal("lead-id")) },
					retype: "lead_copy",
				}),
			]),
		).not.toContain("CASE_OPERATION_RETYPE_UNSAFE");
	});

	it("uses directional storage assignment for operation values", () => {
		for (const operation of [
			update({
				writes: [{ property: "tags", value: term(literal("one")) }],
			}),
			update({
				writes: [{ property: "score", value: term(literal(1.5)) }],
			}),
			update({
				writes: [{ property: "nickname", value: term(literal(null)) }],
			}),
			update({
				writes: [
					{
						property: "score",
						value: ifExpr(
							eq(formField(TEXT), literal("whole")),
							term(literal(1)),
							term(literal(1.5)),
						),
					},
				],
			}),
			update({
				writes: [
					{
						property: "tags",
						value: ifExpr(
							eq(formField(TEXT), literal("copy")),
							term(prop("patient", "tags")),
							term(literal("one")),
						),
					},
				],
			}),
			update({ owner: term(prop("patient", "tags")) }),
			update({ owner: concat(term(prop("patient", "tags"))) }),
			update({ owner: double(term(literal(true))) }),
			update({
				target: {
					kind: "expression",
					expr: term(prop("patient", "tags")),
				},
			}),
		]) {
			expectCode("CASE_OPERATION_EXPRESSION_TYPE", [operation]);
		}

		// An integer is a total subset of Nova's decimal JSON number shape.
		expect(
			codesFor([
				update({
					writes: [{ property: "weight", value: term(literal(1)) }],
				}),
			]),
		).not.toContain("CASE_OPERATION_EXPRESSION_TYPE");
		// Multi-select keeps its array representation end to end; the SQL
		// binding regression lives beside compileExpression's harness test.
		expect(
			codesFor([
				update({
					writes: [{ property: "tags", value: term(formField(MULTI)) }],
				}),
			]),
		).not.toContain("CASE_OPERATION_EXPRESSION_TYPE");
	});
});

describe("case-operation target and dependency safety", () => {
	it("requires session targets to exist and match the module type", () => {
		expectCode(
			"CASE_OPERATION_SESSION_UNAVAILABLE",
			[update()],
			"registration",
		);
		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			update({ caseType: "visit" }),
		]);
	});

	it("requires a loaded case for relationship expressions even without a property filter", () => {
		expectCode(
			"CASE_OPERATION_SESSION_UNAVAILABLE",
			[
				update({
					target: {
						kind: "expression",
						expr: term(literal("patient-id")),
					},
					condition: exists(subcasePath("parent", "visit")),
				}),
			],
			"registration",
		);
	});

	it("requires op/id-of references to name an earlier create of the expected type", () => {
		expectCode("CASE_OPERATION_REFERENCE_ORDER", [
			update({ order: "a", target: { kind: "op", opUuid: CREATE } }),
			create({ order: "b" }),
		]);
		expectCode("CASE_OPERATION_REFERENCE_ORDER", [
			update({ order: "a", owner: idOf(CREATE) }),
			create({ order: "b" }),
		]);
		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			create(),
			update({ target: { kind: "op", opUuid: CREATE } }),
		]);
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			create(),
			update({
				caseType: "visit",
				target: { kind: "expression", expr: idOf(CREATE) },
			}),
		]);
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			create(),
			update({
				caseType: "visit",
				target: { kind: "expression", expr: concat(idOf(CREATE)) },
			}),
		]);
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			create(),
			update({
				links: [
					{
						identifier: "created_visit",
						targetType: "visit",
						target: {
							kind: "expression",
							expr: concat(idOf(CREATE)),
						},
						relationship: "extension",
					},
				],
			}),
		]);
		const rawKeyIsNotCreatedId = codesFor([
			create({ target: { kind: "new", idFrom: TEXT } }),
			update({
				target: { kind: "expression", expr: term(formField(TEXT)) },
			}),
		]);
		expect(rawKeyIsNotCreatedId).not.toContain("CASE_OPERATION_TARGET_INVALID");
		expect(rawKeyIsNotCreatedId).not.toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
	});

	it("tracks retypes across later operations on the same known target", () => {
		const transitionedCreate: CaseOperation[] = [
			create(),
			update({
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
				retype: "client",
				writes: [{ property: "enrolled", value: term(literal("yes")) }],
			}),
			update({
				uuid: THIRD,
				id: "update_client",
				order: "c",
				caseType: "client",
				target: { kind: "op", opUuid: CREATE },
			}),
		];
		expect(codesFor(transitionedCreate)).not.toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			...transitionedCreate.slice(0, -1),
			update({
				uuid: THIRD,
				id: "stale_visit_update",
				order: "c",
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
			}),
		]);

		expect(
			codesFor([
				update({ order: "a", retype: "visit" }),
				update({
					uuid: THIRD,
					id: "update_retyped_session_case",
					order: "b",
					caseType: "visit",
				}),
			]),
		).not.toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");

		expect(
			codesFor([
				update({
					order: "a",
					retype: "visit",
					condition: { kind: "match-all" },
				}),
				update({
					uuid: THIRD,
					id: "update_conditionally_retyped_case",
					order: "b",
					caseType: "visit",
				}),
			]),
		).not.toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");
	});

	it("rejects runtime target aliases that could bypass rolling retype state", () => {
		const errors = errorsFor([
			update({ order: "a", retype: "visit" }),
			update({
				uuid: THIRD,
				id: "stale_snapshot_alias",
				order: "b",
				target: { kind: "expression", expr: term(prop("patient", "case_id")) },
			}),
		]);
		expect(errors.map((error) => error.code)).toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
		expect(
			errors.find(
				(error) => error.code === "CASE_OPERATION_TARGET_TYPE_MISMATCH",
			)?.message,
		).toContain("same concrete case");

		// Distinct literals are one of the few dynamic identities Nova can prove
		// cannot alias, so unrelated work remains representable after a retype.
		expect(
			codesFor([
				update({
					order: "a",
					target: {
						kind: "expression",
						expr: term(literal("patient-a")),
					},
					retype: "visit",
				}),
				update({
					uuid: THIRD,
					id: "different_patient",
					order: "b",
					target: {
						kind: "expression",
						expr: term(literal("patient-b")),
					},
				}),
			]),
		).not.toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");

		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			update({ order: "a", retype: "visit" }),
			update({
				uuid: THIRD,
				id: "link_stale_snapshot_alias",
				order: "b",
				caseType: "visit",
				links: [
					{
						identifier: "patient_alias",
						targetType: "patient",
						target: {
							kind: "expression",
							expr: term(prop("patient", "case_id")),
						},
						relationship: "child",
					},
				],
			}),
		]);
	});

	it("includes ordinary primary updates and subcase parent links in rolling type safety", () => {
		const primaryWrite = fixture();
		mapFieldToCaseType(primaryWrite.doc, TEXT, "nickname", "patient");
		(primaryWrite.doc.forms[primaryWrite.formUuid] as Form).caseOperations = [
			update({ retype: "visit" }),
		];
		const primaryErrors = validateCaseOperations(
			primaryWrite.doc,
			primaryWrite.formUuid,
			primaryWrite.moduleUuid,
		);
		expect(primaryErrors.map((error) => error.code)).toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
		expect(
			primaryErrors.find(
				(error) => error.code === "CASE_OPERATION_TARGET_TYPE_MISMATCH",
			)?.message,
		).toContain("ordinary form action's session target");

		const runtimeAlias = fixture();
		mapFieldToCaseType(runtimeAlias.doc, TEXT, "nickname", "patient");
		(runtimeAlias.doc.forms[runtimeAlias.formUuid] as Form).caseOperations = [
			update({
				target: {
					kind: "expression",
					expr: term(prop("patient", "case_id")),
				},
				retype: "visit",
			}),
		];
		expect(
			validateCaseOperations(
				runtimeAlias.doc,
				runtimeAlias.formUuid,
				runtimeAlias.moduleUuid,
			).map((error) => error.code),
		).toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");

		const childCase = fixture();
		mapFieldToCaseType(childCase.doc, TEXT, "case_name", "visit");
		(childCase.doc.forms[childCase.formUuid] as Form).caseOperations = [
			update({ retype: "visit" }),
		];
		expect(
			validateCaseOperations(
				childCase.doc,
				childCase.formUuid,
				childCase.moduleUuid,
			).map((error) => error.code),
		).toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");
	});

	it("keeps conditional retype branches visible to the final ordinary update", () => {
		const built = fixture();
		mapFieldToCaseType(built.doc, TEXT, "nickname", "patient");
		(built.doc.forms[built.formUuid] as Form).caseOperations = [
			update({
				order: "a",
				retype: "visit",
				condition: eq(formField(TEXT), literal("transition")),
			}),
			update({
				uuid: THIRD,
				id: "restore_patient",
				order: "b",
				caseType: "visit",
				retype: "patient",
				condition: eq(formField(NUMBER), literal(1)),
			}),
		];

		expect(
			validateCaseOperations(built.doc, built.formUuid, built.moduleUuid).map(
				(error) => error.code,
			),
		).toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");
	});

	it("keeps an ordinary close-only action type-agnostic", () => {
		expect(codesFor([update({ retype: "visit" })], "close")).not.toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
	});

	it("allows repeated retype only for a correlated fresh create", () => {
		expect(
			codesFor([
				create({ forEach: { repeat: REPEAT_A } }),
				update({
					caseType: "visit",
					target: { kind: "op", opUuid: CREATE },
					forEach: { repeat: REPEAT_A },
					retype: "client",
					writes: [{ property: "enrolled", value: term(literal("yes")) }],
				}),
			]),
		).not.toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");

		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			create({
				forEach: { repeat: REPEAT_A },
				target: { kind: "new", idFrom: REPEAT_A_TEXT },
			}),
			update({
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
				forEach: { repeat: REPEAT_A },
				retype: "client",
				writes: [{ property: "enrolled", value: term(literal("yes")) }],
			}),
		]);
		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			update({
				forEach: { repeat: REPEAT_A },
				retype: "visit",
			}),
		]);
	});

	it("rejects ambiguous and cross-repeat create references", () => {
		expectCode("CASE_OPERATION_AMBIGUOUS_REFERENCE", [
			create({ forEach: { repeat: REPEAT_A } }),
			update({
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
			}),
		]);
		expectCode("CASE_OPERATION_REPEAT_CORRELATION", [
			create({ forEach: { repeat: REPEAT_A } }),
			update({
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
				forEach: { repeat: REPEAT_B },
			}),
		]);
	});

	it("correlates authored create ids and repeated field reads exactly", () => {
		expect(
			codesFor([create({ target: { kind: "new", idFrom: HIDDEN_ID } })]),
		).not.toContain("CASE_OPERATION_TARGET_INVALID");
		expect(
			codesFor([
				create({ target: { kind: "new", idFrom: HIDDEN_ID } }),
				create({
					uuid: SECOND,
					id: "create_distinct_namespaced_case",
					order: "b",
					target: { kind: "new", idFrom: HIDDEN_ID },
				}),
			]),
		).not.toContain("CASE_OPERATION_TARGET_INVALID");
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			create({ target: { kind: "new", idFrom: NUMBER } }),
		]);
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			create({ target: { kind: "new", idFrom: MULTI } }),
		]);
		expectCode("CASE_OPERATION_REPEAT_CORRELATION", [
			create({
				target: { kind: "new", idFrom: REPEAT_B_TEXT },
				forEach: { repeat: REPEAT_A },
			}),
		]);
		expectCode("CASE_OPERATION_AMBIGUOUS_REFERENCE", [
			update({ owner: term(formField(REPEAT_A_TEXT)) }),
		]);
		expectCode("CASE_OPERATION_REPEAT_CORRELATION", [
			update({
				owner: term(formField(REPEAT_B_TEXT)),
				forEach: { repeat: REPEAT_A },
			}),
		]);
	});

	it("correlates table-lookup filters with the operation repeat ancestry only", () => {
		const built = nestedRepeatFixture();
		const repeatCodes = (
			fieldUuid: Uuid,
			mode: "repeated" | "singular" = "repeated",
		): ValidationErrorCode[] => {
			(built.doc.forms[built.formUuid] as Form).caseOperations = [
				update({
					...(mode === "repeated" && {
						forEach: { repeat: REPEAT_B },
					}),
					owner: tableLookup(
						LOOKUP_TABLE,
						LOOKUP_COLUMN,
						eq(formField(fieldUuid), literal("eligible")),
					),
				}),
			];
			return validateCaseOperations(
				built.doc,
				built.formUuid,
				built.moduleUuid,
				LOOKUP_TYPES,
			).map((error) => error.code);
		};

		for (const validField of [TEXT, REPEAT_A_TEXT, REPEAT_B_TEXT]) {
			const codes = repeatCodes(validField);
			expect(codes, validField).not.toContain(
				"CASE_OPERATION_AMBIGUOUS_REFERENCE",
			);
			expect(codes, validField).not.toContain(
				"CASE_OPERATION_REPEAT_CORRELATION",
			);
		}
		for (const invalidField of [REPEAT_CHILD_TEXT, REPEAT_SIBLING_TEXT]) {
			expect(repeatCodes(invalidField), invalidField).toContain(
				"CASE_OPERATION_REPEAT_CORRELATION",
			);
		}
		expect(repeatCodes(REPEAT_A_TEXT, "singular")).toContain(
			"CASE_OPERATION_AMBIGUOUS_REFERENCE",
		);

		const predicateCodes = (fieldUuid: Uuid): ValidationErrorCode[] => {
			(built.doc.forms[built.formUuid] as Form).caseOperations = [
				update({
					forEach: { repeat: REPEAT_B },
					condition: eq(
						tableLookup(
							LOOKUP_TABLE,
							LOOKUP_COLUMN,
							eq(formField(fieldUuid), literal("eligible")),
						),
						literal("matched"),
					),
				}),
			];
			return validateCaseOperations(
				built.doc,
				built.formUuid,
				built.moduleUuid,
				LOOKUP_TYPES,
			).map((error) => error.code);
		};
		expect(predicateCodes(REPEAT_A_TEXT)).not.toContain(
			"CASE_OPERATION_REPEAT_CORRELATION",
		);
		expect(predicateCodes(REPEAT_CHILD_TEXT)).toContain(
			"CASE_OPERATION_REPEAT_CORRELATION",
		);

		(built.doc.forms[built.formUuid] as Form).caseOperations = [
			update({
				forEach: { repeat: REPEAT_B },
				owner: term(formField(REPEAT_A_TEXT)),
			}),
		];
		expect(
			validateCaseOperations(
				built.doc,
				built.formUuid,
				built.moduleUuid,
				LOOKUP_TYPES,
			).map((error) => error.code),
		).toContain("CASE_OPERATION_REPEAT_CORRELATION");

		(built.doc.forms[built.formUuid] as Form).caseOperations = [
			update({
				forEach: { repeat: REPEAT_B },
				condition: eq(formField(REPEAT_A_TEXT), literal("ordinary")),
			}),
		];
		expect(
			validateCaseOperations(
				built.doc,
				built.formUuid,
				built.moduleUuid,
				LOOKUP_TYPES,
			).map((error) => error.code),
		).toContain("CASE_OPERATION_REPEAT_CORRELATION");
	});

	it("type-checks runtime targets and every value slot", () => {
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({ target: { kind: "expression", expr: term(literal(7)) } }),
		]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				writes: [{ property: "score", value: term(literal("seven")) }],
			}),
		]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({ owner: term(formField(REPEAT_A)) }),
		]);
	});

	it("rejects disagreement between operation writers before schema materialization", () => {
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				writes: [{ property: "mixed", value: term(literal(7)) }],
			}),
			update({
				uuid: THIRD,
				id: "write_mixed_as_text",
				order: "c",
				writes: [{ property: "mixed", value: term(literal("seven")) }],
			}),
		]);
	});
});

describe("case-operation links and on-device totality", () => {
	it("rejects malformed/duplicate links, create targets, and statically-known self links", () => {
		expectCode("CASE_OPERATION_LINK_INVALID", [
			update({
				links: [
					{
						identifier: `i${"x".repeat(255)}`,
						targetType: "visit",
						target: null,
						relationship: "child",
					},
				],
			}),
		]);
		expectCode("CASE_OPERATION_LINK_INVALID", [
			update({
				links: [
					{
						identifier: "bad-link",
						targetType: "visit",
						target: { kind: "new" },
						relationship: "child",
					},
					{
						identifier: "bad-link",
						targetType: "patient",
						target: { kind: "session" },
						relationship: "child",
					},
				],
			}),
		]);
		expectCode("CASE_OPERATION_LINK_INVALID", [
			update({
				links: [
					{
						identifier: "self",
						targetType: "patient",
						target: { kind: "session" },
						relationship: "extension",
					},
				],
			}),
		]);
		expectCode("CASE_OPERATION_LINK_INVALID", [
			update({
				target: { kind: "expression", expr: term(literal("case-1")) },
				links: [
					{
						identifier: "self",
						targetType: "patient",
						target: {
							kind: "expression",
							expr: term(literal("case-1")),
						},
						relationship: "extension",
					},
				],
			}),
		]);
		expectCode("CASE_OPERATION_LINK_INVALID", [
			create(),
			update({
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
				links: [
					{
						identifier: "self",
						targetType: "visit",
						target: { kind: "expression", expr: idOf(CREATE) },
						relationship: "extension",
					},
				],
			}),
		]);
	});

	it("tracks exact runtime target types across link assertions", () => {
		const runtimeTarget = {
			kind: "expression" as const,
			expr: term(literal("case-1")),
		};
		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			update({
				links: [
					{
						identifier: "visit_link",
						targetType: "visit",
						target: runtimeTarget,
						relationship: "child",
					},
					{
						identifier: "patient_link",
						targetType: "patient",
						target: runtimeTarget,
						relationship: "child",
					},
				],
			}),
		]);
	});

	it("admits multiple declared operations on one target because order is semantic", () => {
		expect(
			codesFor([
				update(),
				update({ uuid: THIRD, id: "rename_patient", order: "c" }),
			]),
		).toEqual(["CASE_OPERATIONS_NOT_ACTIVE"]);
	});

	it("rejects statically blank or overlong name, rename, and owner facets", () => {
		for (const operation of [
			create({ name: term(literal(" \t\r\n ")) }),
			create({ owner: term(literal("")) }),
			update({ rename: term(literal("x".repeat(256))) }),
			update({ owner: term(literal("x".repeat(256))) }),
		]) {
			expectCode("CASE_OPERATION_EXPRESSION_TYPE", [operation]);
		}

		expect(
			codesFor([
				update({
					rename: term(literal(`  ${"x".repeat(255)}  `)),
					owner: term(literal("owner")),
				}),
			]),
		).toEqual(["CASE_OPERATIONS_NOT_ACTIVE"]);
	});

	it("rejects schema-valid expressions that the on-device emitter cannot execute", () => {
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				owner: dateAdd(today(), "months", term(literal(1))),
			}),
		]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				owner: unwrapList(term(prop("patient", "nickname"))),
			}),
		]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				owner: term(
					prop("patient", "source_id", subcasePath("parent", "visit")),
				),
			}),
		]);
	});
});
