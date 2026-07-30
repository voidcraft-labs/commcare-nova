import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { caseOperationWriteValueType } from "@/lib/doc/caseOperationWriteTypes";
import type { BlueprintDoc, CaseOperation, Form, Uuid } from "@/lib/domain";
import { formField, literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const SUBJECT = testUuid("11111111-1111-4111-8111-111111111111");
const SIBLING = testUuid("22222222-2222-4222-8222-222222222222");
const ELSEWHERE = testUuid("33333333-3333-4333-8333-333333333333");
const DATE_FIELD = testUuid("44444444-4444-4444-8444-444444444444");

/**
 * One case type whose properties cover each way a type can already be
 * pinned — declared outright, written by a sibling operation, written by
 * a field, written from another form — plus one written by nothing but
 * the operation under test.
 *
 * Every property except `declared_date` is catalog-present and
 * TYPELESS, which is the real shape: `ensureCatalogProperty` appends a
 * writer's property to the declared type without a `data_type`, and
 * `effectiveCaseTypes` is what fills one in.
 */
function fixture(): {
	doc: BlueprintDoc;
	formUuid: Uuid;
	otherFormUuid: Uuid;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "declared_date",
						label: proseText("Declared date"),
						data_type: "date",
					},
					{ name: "operation_only", label: proseText("Operation only") },
					{ name: "two_operations", label: proseText("Two operations") },
					{ name: "field_written", label: proseText("Field written") },
					{ name: "written_elsewhere", label: proseText("Written elsewhere") },
				],
			},
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
								uuid: DATE_FIELD,
								kind: "date",
								id: "field_written",
								label: proseText("Field written"),
								caseWrite: {
									caseType: "patient",
									property: "field_written",
								},
							}),
						],
					},
					{ name: "Other", type: "followup", fields: [] },
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const [formUuid, otherFormUuid] = doc.formOrder[moduleUuid];

	const subject: CaseOperation = {
		uuid: SUBJECT,
		id: "record_visit",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [
			{ property: "declared_date", value: term(literal("hello")) },
			{ property: "operation_only", value: term(literal("hello")) },
			{ property: "two_operations", value: term(literal("hello")) },
			{ property: "field_written", value: term(formField(DATE_FIELD)) },
			{ property: "written_elsewhere", value: term(literal("hello")) },
		],
	};
	const sibling: CaseOperation = {
		uuid: SIBLING,
		id: "tag_visit",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "two_operations", value: term(literal("hello")) }],
	};
	const elsewhere: CaseOperation = {
		uuid: ELSEWHERE,
		id: "note_visit",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "written_elsewhere", value: term(literal("hello")) }],
	};
	(doc.forms[formUuid] as Form).caseOperations = [subject, sibling];
	(doc.forms[otherFormUuid] as Form).caseOperations = [elsewhere];

	return { doc, formUuid, otherFormUuid };
}

function typeOf(property: string): string | undefined {
	const { doc, formUuid } = fixture();
	return caseOperationWriteValueType(
		doc,
		formUuid,
		SUBJECT,
		"patient",
		property,
	);
}

describe("the type a case-operation write's value must satisfy", () => {
	it("leaves the value free when this write is the only thing typing the property", () => {
		// The regression the module exists for: `effectiveCaseTypes` would
		// answer `text` here — inferred from the very write being edited —
		// and the editor would refuse every later attempt to store a date.
		expect(typeOf("operation_only")).toBeUndefined();
	});

	it("takes a declared type even when this write is the only writer", () => {
		// Order matters: the declaration is consulted BEFORE sole-writer, or
		// a declared property with one writer would read as unconstrained.
		expect(typeOf("declared_date")).toBe("date");
	});

	it("takes a sibling operation's type, which no carrier lookup can see", () => {
		// Both operations register their declarations under the FORM, so the
		// reference index reports one carrier for two writers; the siblings
		// have to be read off the form itself.
		expect(typeOf("two_operations")).toBe("text");
	});

	it("takes a same-form field's type", () => {
		// A field carries its own uuid, so it is already a foreign carrier
		// even though it sits in this very form.
		expect(typeOf("field_written")).toBe("date");
	});

	it("takes a writer in another form's type", () => {
		expect(typeOf("written_elsewhere")).toBe("text");
	});
});
