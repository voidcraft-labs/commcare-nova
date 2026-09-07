import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	CASE_OPERATION_PROPERTY_FORMAT_MESSAGE,
	type CaseOperation,
	deriveCaseWriteInventory,
	lookupColumnIdSchema,
	lookupTableIdSchema,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import {
	concat,
	count,
	dateAdd,
	double,
	eq,
	exists,
	fixedLocation,
	formField,
	idOf,
	ifExpr,
	isBlank,
	literal,
	match,
	ownerLocationAtLevel,
	prop,
	subcasePath,
	tableLookup,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { ValidationErrorCode } from "../errors";
import { runValidation } from "../runner";

const CREATE = testUuid("11111111-1111-4111-8111-111111111111");
const SECOND = testUuid("22222222-2222-4222-8222-222222222222");
const THIRD = testUuid("33333333-3333-4333-8333-333333333333");
const TEXT = testUuid("44444444-4444-4444-8444-444444444444");
const NUMBER = testUuid("55555555-5555-4555-8555-555555555555");
const REPEAT_A = testUuid("66666666-6666-4666-8666-666666666666");
const REPEAT_A_TEXT = testUuid("77777777-7777-4777-8777-777777777777");
const REPEAT_B = testUuid("88888888-8888-4888-8888-888888888888");
const REPEAT_B_TEXT = testUuid("99999999-9999-4999-8999-999999999999");
const HIDDEN_ID = testUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const MULTI = testUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const REPEAT_CHILD = testUuid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const REPEAT_CHILD_TEXT = testUuid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
const REPEAT_SIBLING = testUuid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
const REPEAT_SIBLING_TEXT = testUuid("ffffffff-ffff-4fff-8fff-ffffffffffff");
const LOOKUP_TABLE = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-0000000000a1",
);
const LOOKUP_COLUMN = lookupColumnIdSchema.parse(
	"10000000-0000-7000-8000-0000000000a1",
);

const LOOKUP_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: "project",
	projectRevision: parseLookupRevision("1"),
	definitions: [
		{
			id: LOOKUP_TABLE,
			name: "Owners",
			tag: "owners",
			definitionRevision: parseLookupRevision("1"),
			columns: [
				{
					id: LOOKUP_COLUMN,
					wireName: "owner",
					label: "Owner",
					dataType: "text",
				},
			],
		},
	],
};
// Complete document admission and diagnostic attribution. Native Core/HQ execution
// and Postgres storage semantics are exercised by their respective integration corpora.
function validateCandidate(
	doc: BlueprintDoc,
	context: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
) {
	// Tests assemble candidates imperatively; production documents have a new root per revision.
	const candidate = { ...doc };
	const errors = runValidation(candidate, context);
	if (errors.length === 0) expectAdmittedDoc(candidate, context);
	return errors;
}

interface Fixture {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}

function fixture(
	formType: "followup" | "registration" | "close" = "followup",
): Fixture {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
					{ name: "score", label: proseText("Score"), data_type: "int" },
					{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
					{
						name: "visited_at",
						label: proseText("Visited at"),
						data_type: "datetime",
					},
					{
						name: "next_visit_at",
						label: proseText("Next visit at"),
						data_type: "datetime",
					},
					{
						name: "visited_on",
						label: proseText("Visited on"),
						data_type: "date",
					},
					{
						name: "next_visit_on",
						label: proseText("Next visit on"),
						data_type: "date",
					},
					{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
					{ name: "mixed", label: proseText("Mixed") },
				],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "source_id", label: proseText("Source ID") }],
			},
			{
				name: "lead",
				properties: [{ name: "legacy", label: proseText("Legacy") }],
			},
			{
				name: "lead_copy",
				properties: [{ name: "legacy", label: proseText("Legacy") }],
			},
			{
				name: "client",
				properties: [
					{
						name: "enrolled",
						label: proseText("Enrolled"),
						required: "true()",
					},
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("case-ops-column"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Edit",
						type: formType,
						fields: [
							f({
								uuid: TEXT,
								kind: "text",
								id: "text",
								label: proseText("Text"),
								...(formType === "registration" && {
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							}),
							f({
								uuid: NUMBER,
								kind: "int",
								id: "number",
								label: proseText("Number"),
							}),
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
								label: proseText("Choices"),
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}),
							f({
								uuid: REPEAT_A,
								kind: "repeat",
								id: "rows_a",
								label: proseText("Rows A"),
								repeat_mode: "user_controlled",
								children: [
									f({
										uuid: REPEAT_A_TEXT,
										kind: "text",
										id: "row_a_text",
										label: proseText("Row A text"),
									}),
								],
							}),
							f({
								uuid: REPEAT_B,
								kind: "repeat",
								id: "rows_b",
								label: proseText("Rows B"),
								repeat_mode: "user_controlled",
								children: [
									f({
										uuid: REPEAT_B_TEXT,
										kind: "text",
										id: "row_b_text",
										label: proseText("Row B text"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});

	// Retype-order examples retain source properties; separate tests below use
	// lead/client to exercise intentionally nonportable catalog transitions.
	const patient = doc.caseTypes?.find((entry) => entry.name === "patient");
	const visit = doc.caseTypes?.find((entry) => entry.name === "visit");
	const client = doc.caseTypes?.find((entry) => entry.name === "client");
	if (patient === undefined || visit === undefined || client === undefined)
		throw new Error("Missing fixture case catalog");
	visit.properties = [...patient.properties, ...visit.properties];
	client.properties = [...visit.properties, ...client.properties];
	const moduleUuid = doc.moduleOrder[0];
	expectAdmittedDoc(doc);
	return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
}

function nestedRepeatFixture(): Fixture {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("case-ops-column"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Edit",
						type: "followup",
						fields: [
							f({
								uuid: TEXT,
								kind: "text",
								id: "root",
								label: proseText("Root"),
							}),
							f({
								uuid: REPEAT_A,
								kind: "repeat",
								id: "outer",
								label: proseText("Outer"),
								children: [
									f({
										uuid: REPEAT_A_TEXT,
										kind: "text",
										id: "outer_text",
										label: proseText("Outer text"),
									}),
									f({
										uuid: REPEAT_B,
										kind: "repeat",
										id: "inner",
										label: proseText("Inner"),
										children: [
											f({
												uuid: REPEAT_B_TEXT,
												kind: "text",
												id: "inner_text",
												label: proseText("Inner text"),
											}),
											f({
												uuid: REPEAT_CHILD,
												kind: "repeat",
												id: "child",
												label: proseText("Child"),
												children: [
													f({
														uuid: REPEAT_CHILD_TEXT,
														kind: "text",
														id: "child_text",
														label: proseText("Child text"),
													}),
												],
											}),
										],
									}),
									f({
										uuid: REPEAT_SIBLING,
										kind: "repeat",
										id: "sibling",
										label: proseText("Sibling"),
										children: [
											f({
												uuid: REPEAT_SIBLING_TEXT,
												kind: "text",
												id: "sibling_text",
												label: proseText("Sibling text"),
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
	expectAdmittedDoc(doc);
	return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
}

function create(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: CREATE,
		id: "create_visit",
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
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		...patch,
	};
}

function errorsFor(
	operations: readonly CaseOperation[],
	formType: "followup" | "registration" | "close" = "followup",
): ReturnType<typeof validateCandidate> {
	const built = fixture(formType);
	built.doc.forms[built.formUuid].caseOperations = [...operations];
	return validateCandidate(built.doc);
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
	property: string = id,
): void {
	const field = doc.fields[fieldUuid];
	if (field.kind !== "text")
		throw new Error("Fixture mapping requires a text field");
	field.id = id;
	field.caseWrite = { caseType, property };
}

describe("case-operation on-device portability", () => {
	// These tests exercise the complete admission rule, including its emitter
	// dry run. Native execution belongs to the Core/HQ operation corpus.

	it.each(["fuzzy", "phonetic", "fuzzy-date"] as const)(
		"rejects the %s match mode a device cannot evaluate",
		(mode) => {
			expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
				update({
					condition: match(
						prop("patient", mode === "fuzzy-date" ? "visited_on" : "nickname"),
						mode === "fuzzy-date" ? "2026-09-06" : "ali",
						mode,
					),
				}),
			]);
		},
	);

	it("rejects an unevaluable match mode nested in a count's where", () => {
		// `count` reaches the same emitter through the on-device expression
		// emitter's own relation arm, so the finding must survive nesting
		// inside a value slot rather than only at a condition's root.
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				writes: [
					{
						property: "nickname",
						value: concat(
							term(literal("n=")),
							count(
								subcasePath("parent", "visit"),
								match(prop("visit", "source_id"), "ali", "fuzzy"),
							),
						),
					},
				],
			}),
		]);
	});

	it("keeps the blank check, which is the portable answer", () => {
		expect(
			codesFor([
				update({ condition: isBlank(term(prop("patient", "nickname"))) }),
			]),
		).toEqual([]);
	});

	it("keeps starts-with, the one mode CommCare Core registers", () => {
		expect(
			codesFor([
				update({
					condition: match(prop("patient", "nickname"), "ali", "starts-with"),
				}),
			]),
		).toEqual([]);
	});
});

describe("case-operation activation and identity", () => {
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

	it("accepts underscores but rejects hyphens and dots in emitted node names", () => {
		expect(codesFor([update({ id: "_update_patient2" })])).toEqual([]);
		for (const id of ["update-patient", "update.patient"]) {
			const error = errorsFor([update({ id })]).find(
				(candidate) => candidate.code === "CASE_OPERATION_INVALID_ID",
			);
			expect(error?.message).toContain(
				CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
			);
		}
		for (const property of ["not-wire-safe", "not.wire.safe"]) {
			const error = errorsFor([
				update({
					writes: [{ property, value: term(literal("not emitted as a node")) }],
				}),
			]).find(
				(candidate) => candidate.code === "CASE_OPERATION_UNKNOWN_PROPERTY",
			);
			expect(error?.message).toContain(CASE_OPERATION_PROPERTY_FORMAT_MESSAGE);
		}
		for (const identifier of ["parent-link", "parent.link"]) {
			const error = errorsFor([
				update({
					links: [
						{
							identifier,
							targetType: "visit",
							target: null,
							relationship: "child",
						},
					],
				}),
			]).find((candidate) => candidate.code === "CASE_OPERATION_LINK_INVALID");
			expect(error?.message).toContain(
				CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
			);
		}
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
					forEach: { repeat: REPEAT_A },
				}),
				update(),
			]),
		).toContain("CASE_OPERATION_EXECUTION_ORDER");

		expect(
			codesFor([
				update({
					uuid: THIRD,
					id: "update_rows_b",
					forEach: { repeat: REPEAT_B },
				}),
				update({ forEach: { repeat: REPEAT_A } }),
			]),
		).toContain("CASE_OPERATION_EXECUTION_ORDER");

		expectCode("CASE_OPERATION_EXECUTION_ORDER", [
			update(),
			create({ target: { kind: "new", idFrom: TEXT } }),
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
		).toEqual([]);

		const siblingScopes = fixture();
		siblingScopes.doc.forms[siblingScopes.formUuid].caseOperations = [
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
			validateCandidate(siblingScopes.doc).map((error) => error.code),
		).toEqual([]);

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
		nestedScopes.doc.forms[nestedScopes.formUuid].caseOperations = [
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
			validateCandidate(nestedScopes.doc).map((error) => error.code),
		).toContain("CASE_OPERATION_EXECUTION_ORDER");
	});
});

describe("case-operation action, catalog, and reserved vocabulary", () => {
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

	it("rejects undeclared, duplicate, malformed, and reserved metadata writes", () => {
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
			"owner_id",
			"date_opened",
			"date_modified",
			"location_id",
			"hq_user_id",
			"category",
			"state",
		]) {
			expectCode("CASE_OPERATION_RESERVED_PROPERTY", [
				update({ writes: [{ property, value: term(literal("x")) }] }),
			]);
		}
	});

	it("admits external_id through the generic write slot without a catalog declaration", () => {
		const built = fixture();
		built.doc.forms[built.formUuid].caseOperations = [
			update({
				writes: [
					{
						property: "external_id",
						value: term(literal("patient-123")),
					},
				],
			}),
		];
		const codes = validateCandidate(built.doc).map((error) => error.code);
		expect(codes).toEqual([]);
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
		).toEqual([]);
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
		).toEqual([]);
		// Multi-select keeps its array representation end to end; the SQL
		// binding regression lives beside compileExpression's harness test.
		expect(
			codesFor([
				update({
					writes: [{ property: "tags", value: term(formField(MULTI)) }],
				}),
			]),
		).toEqual([]);
	});
});

describe("case-operation target and dependency safety", () => {
	it("loads the session case for a follow-up form in a mixed forms-first module", () => {
		const built = fixture("followup");
		const registrationUuid = testUuid("abababab-abab-4bab-8bab-abababababab");

		const registration = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Registration",
					caseType: "patient",
					forms: [
						{
							uuid: registrationUuid,
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "patient_name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
		});
		built.doc.forms[registrationUuid] = registration.forms[registrationUuid];
		built.doc.fieldOrder[registrationUuid] =
			registration.fieldOrder[registrationUuid];
		Object.assign(built.doc.fields, registration.fields);

		built.doc.formOrder[built.moduleUuid] = [registrationUuid, built.formUuid];
		built.doc.forms[built.formUuid].caseOperations = [
			update({
				condition: eq(
					term(prop("patient", "nickname")),
					term(literal("ready")),
				),
			}),
		];

		expect(validateCandidate(built.doc).map((error) => error.code)).toEqual([]);
	});

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

	it("requires a loaded case for an owner-to-place reverse hop", () => {
		expectCode(
			"CASE_OPERATION_SESSION_UNAVAILABLE",
			[
				update({
					owner: term(
						ownerLocationAtLevel(
							testUuid("owner-destination-level"),
							"patient",
						),
					),
				}),
			],
			"registration",
		);
	});

	it("requires op/id-of references to name an earlier create of the expected type", () => {
		expectCode("CASE_OPERATION_REFERENCE_ORDER", [
			update({ target: { kind: "op", opUuid: CREATE } }),
			create(),
		]);
		expectCode("CASE_OPERATION_REFERENCE_ORDER", [
			update({ owner: idOf(CREATE) }),
			create(),
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
		expect(rawKeyIsNotCreatedId).toEqual([]);
	});

	it("rejects blank calculated case ids for operation and link targets", () => {
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			update({
				target: { kind: "expression", expr: term(literal(" \t\r\n")) },
			}),
		]);
		expectCode("CASE_OPERATION_TARGET_INVALID", [
			update({
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: {
							kind: "expression",
							expr: term(literal("\v\f")),
						},
						relationship: "child",
					},
				],
			}),
		]);
		expect(
			codesFor([
				update({
					target: {
						kind: "expression",
						expr: term(literal(` ${"x".repeat(300)} `)),
					},
				}),
			]),
		).toEqual([]);
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
				caseType: "client",
				target: { kind: "op", opUuid: CREATE },
			}),
		];
		expect(codesFor(transitionedCreate)).toEqual([]);
		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			...transitionedCreate.slice(0, -1),
			update({
				uuid: THIRD,
				id: "stale_visit_update",
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
			}),
		]);

		expect(
			codesFor([
				update({ retype: "visit" }),
				update({
					uuid: THIRD,
					id: "update_retyped_session_case",
					caseType: "visit",
				}),
			]),
		).toEqual([]);

		expect(
			codesFor([
				update({
					retype: "visit",
					condition: { kind: "match-all" },
				}),
				update({
					uuid: THIRD,
					id: "update_conditionally_retyped_case",
					caseType: "visit",
				}),
			]),
		).toEqual([]);
	});

	it("rejects runtime target aliases that could bypass rolling retype state", () => {
		const errors = errorsFor([
			update({ retype: "visit" }),
			update({
				uuid: THIRD,
				id: "stale_snapshot_alias",
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
					target: {
						kind: "expression",
						expr: term(literal("patient-a")),
					},
					retype: "visit",
				}),
				update({
					uuid: THIRD,
					id: "different_patient",
					target: {
						kind: "expression",
						expr: term(literal("patient-b")),
					},
				}),
			]),
		).toEqual([]);

		expectCode("CASE_OPERATION_TARGET_TYPE_MISMATCH", [
			update({ retype: "visit" }),
			update({
				uuid: THIRD,
				id: "link_stale_snapshot_alias",
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
		primaryWrite.doc.forms[primaryWrite.formUuid].caseOperations = [
			update({ retype: "visit" }),
		];
		const primaryErrors = validateCandidate(primaryWrite.doc);
		expect(primaryErrors.map((error) => error.code)).toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
		expect(
			primaryErrors.find(
				(error) => error.code === "CASE_OPERATION_TARGET_TYPE_MISMATCH",
			)?.message,
		).toContain("ordinary form action's session target");

		const primaryName = fixture();
		mapFieldToCaseType(
			primaryName.doc,
			TEXT,
			"friendly_name",
			"patient",
			"case_name",
		);
		primaryName.doc.forms[primaryName.formUuid].caseOperations = [
			update({ retype: "visit" }),
		];
		const primaryNameModule = primaryName.doc.modules[primaryName.moduleUuid];
		if (primaryNameModule === undefined) {
			throw new Error("fixture module is missing");
		}
		const primaryNameInventory = deriveCaseWriteInventory(
			primaryName.doc,
			primaryName.formUuid,
			primaryNameModule,
			primaryName.doc.forms[primaryName.formUuid].type,
		);
		expect(primaryNameInventory.writers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fieldId: "friendly_name",
					caseType: "patient",
					property: "case_name",
				}),
			]),
		);
		expect(
			validateCandidate(primaryName.doc).map((error) => error.code),
		).toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");

		const runtimeAlias = fixture();
		mapFieldToCaseType(runtimeAlias.doc, TEXT, "nickname", "patient");
		runtimeAlias.doc.forms[runtimeAlias.formUuid].caseOperations = [
			update({
				target: {
					kind: "expression",
					expr: term(prop("patient", "case_id")),
				},
				retype: "visit",
			}),
		];
		expect(
			validateCandidate(runtimeAlias.doc).map((error) => error.code),
		).toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");

		const childCase = fixture();
		mapFieldToCaseType(childCase.doc, TEXT, "case_name", "visit");
		childCase.doc.forms[childCase.formUuid].caseOperations = [
			update({ retype: "visit" }),
		];
		expect(
			validateCandidate(childCase.doc).map((error) => error.code),
		).toContain("CASE_OPERATION_TARGET_TYPE_MISMATCH");
	});

	it("keeps conditional retype branches visible to the final ordinary update", () => {
		const built = fixture();
		mapFieldToCaseType(built.doc, TEXT, "nickname", "patient");
		built.doc.forms[built.formUuid].caseOperations = [
			update({
				retype: "visit",
				condition: eq(formField(TEXT), literal("transition")),
			}),
			update({
				uuid: THIRD,
				id: "restore_patient",
				caseType: "visit",
				retype: "patient",
				condition: eq(formField(NUMBER), literal(1)),
			}),
		];

		expect(validateCandidate(built.doc).map((error) => error.code)).toContain(
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
	});

	it("keeps an ordinary close-only action type-agnostic", () => {
		expect(codesFor([update({ retype: "visit" })], "close")).toEqual([]);
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
		).toEqual([]);

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
		).toEqual([]);
		expect(
			codesFor([
				create({ target: { kind: "new", idFrom: HIDDEN_ID } }),
				create({
					uuid: SECOND,
					id: "create_distinct_namespaced_case",
					target: { kind: "new", idFrom: HIDDEN_ID },
				}),
			]),
		).toEqual([]);
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
		// A ROOT answer is readable from a repeated operation but cannot KEY
		// one: it has a single value per submission, so every iteration would
		// derive the same identity and collapse onto one case. The identity
		// rule is exact correlation, never the (looser) read rule.
		expectCode("CASE_OPERATION_REPEAT_CORRELATION", [
			create({
				target: { kind: "new", idFrom: TEXT },
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
			built.doc.forms[built.formUuid].caseOperations = [
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
			return validateCandidate(built.doc, LOOKUP_CONTEXT).map(
				(error) => error.code,
			);
		};

		for (const validField of [TEXT, REPEAT_A_TEXT, REPEAT_B_TEXT]) {
			const codes = repeatCodes(validField);
			expect(codes, validField).toEqual([]);
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
			built.doc.forms[built.formUuid].caseOperations = [
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
			return validateCandidate(built.doc, LOOKUP_CONTEXT).map(
				(error) => error.code,
			);
		};
		expect(predicateCodes(REPEAT_A_TEXT)).toEqual([]);
		expect(predicateCodes(REPEAT_CHILD_TEXT)).toContain(
			"CASE_OPERATION_REPEAT_CORRELATION",
		);

		built.doc.forms[built.formUuid].caseOperations = [
			update({
				forEach: { repeat: REPEAT_B },
				owner: term(formField(REPEAT_A_TEXT)),
			}),
		];
		expect(
			validateCandidate(built.doc, LOOKUP_CONTEXT).map((error) => error.code),
		).toContain("CASE_OPERATION_REPEAT_CORRELATION");

		built.doc.forms[built.formUuid].caseOperations = [
			update({
				forEach: { repeat: REPEAT_B },
				condition: eq(formField(REPEAT_A_TEXT), literal("ordinary")),
			}),
		];
		expect(
			validateCandidate(built.doc, LOOKUP_CONTEXT).map((error) => error.code),
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

	it("rejects statically blank or overlong name, rename, and owner facets", () => {
		for (const operation of [
			create({ name: term(literal(" \t\r\n ")) }),
			create({ owner: term(literal("")) }),
			update({ rename: term(literal("x".repeat(256))) }),
			update({ owner: term(literal("x".repeat(256))) }),
		]) {
			expectCode("CASE_OPERATION_EXPRESSION_TYPE", [operation]);
		}
	});

	it("admits a fixed place only as the complete owner expression", () => {
		const fixed = term(fixedLocation(testUuid("fixed-owner-location")));
		const whole = errorsFor([update({ owner: fixed })]);
		expect(whole.map((error) => error.code)).toEqual([]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({ owner: concat(fixed, term(literal("suffix"))) }),
		]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [create({ name: fixed })]);
	});

	it("rejects calendar-relative dates and non-scalar related-case values", () => {
		const calendarFindings = errorsFor([
			update({
				writes: [
					{
						property: "next_visit_on",
						value: dateAdd(today(), "months", term(literal(1))),
					},
				],
			}),
		]);
		expect(calendarFindings).toEqual([
			expect.objectContaining({
				code: "CASE_OPERATION_EXPRESSION_TYPE",
				details: expect.objectContaining({
					reason: "calendar-interval",
					interval: "months",
				}),
			}),
		]);
		expectCode("CASE_OPERATION_EXPRESSION_TYPE", [
			update({
				owner: term(prop("visit", "source_id", subcasePath("parent", "visit"))),
			}),
		]);
	});

	it("rejects a property-backed datetime calculation before it can lose the time", () => {
		const errors = errorsFor([
			update({
				writes: [
					{
						property: "next_visit_at",
						value: dateAdd(
							term(prop("patient", "visited_at")),
							"days",
							term(literal(1)),
						),
					},
				],
			}),
		]);
		const finding = errors.find(
			(error) => error.code === "CASE_OPERATION_EXPRESSION_TYPE",
		);
		expect(finding?.message).toContain("would discard the time");
		expect(finding?.details).toEqual(
			expect.objectContaining({ reason: "datetime-base", interval: "days" }),
		);

		const conditionFinding = errorsFor([
			update({
				condition: eq(
					dateAdd(
						term(prop("patient", "visited_at")),
						"hours",
						term(literal(1)),
					),
					term(prop("patient", "next_visit_at")),
				),
			}),
		]).find((error) => error.code === "CASE_OPERATION_EXPRESSION_TYPE");
		expect(conditionFinding?.message).toContain("would discard the time");
		expect(conditionFinding?.details).toEqual(
			expect.objectContaining({ reason: "datetime-base", interval: "hours" }),
		);
	});

	it("keeps fixed-duration date arithmetic available in case operations", () => {
		const errors = errorsFor([
			update({
				writes: [
					{
						property: "next_visit_on",
						value: dateAdd(
							term(prop("patient", "visited_on")),
							"weeks",
							term(literal(2)),
						),
					},
				],
			}),
		]);
		expect(errors).toEqual([]);
	});
});
