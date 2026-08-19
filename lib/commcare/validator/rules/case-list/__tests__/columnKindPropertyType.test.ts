import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
// The gate half of the shared column-kind ↔ property-type predicate:
// a RESOLVED mismatch is a finding; unknown passes (honest-unknown-
// permissive — the same verdict the workspace + pickers derive, so
// the gate can never approve a column the workspace marks broken).

import { describe, expect, it } from "vitest";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type Column,
	dateColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH";

function moduleWith(args: { columns: Column[]; fields: FieldSpec[] }) {
	return buildDoc({
		appName: "T",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: { columns: args.columns, searchInputs: [] },
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: args.fields.map((spec) => f(spec)),
					},
				],
			},
		],
	});
}

describe("columnKindPropertyType", () => {
	it("fires on a date column whose property RESOLVES to a non-date type", () => {
		const doc = moduleWith({
			columns: [dateColumn(testUuid("col-1"), "nickname", "Nick", "%Y-%m-%d")],
			fields: [
				f({
					kind: "text",
					id: "nickname",
					label: proseText("Nickname"),
					caseWrite: { caseType: "patient", property: "nickname" },
				}),
			],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some((e) => e.code === CODE && e.message.includes("nickname")),
		).toBe(true);
	});

	it("passes a date column on a writer-derived date property", () => {
		const doc = moduleWith({
			columns: [dateColumn(testUuid("col-1"), "dob", "DOB", "%Y-%m-%d")],
			fields: [
				f({
					kind: "date",
					id: "dob",
					label: proseText("DOB"),
					caseWrite: { caseType: "patient", property: "dob" },
				}),
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === CODE,
			),
		).toBe(false);
	});

	it("passes a date column on a hidden today() writer — inference resolves date", () => {
		const doc = moduleWith({
			columns: [
				dateColumn(testUuid("col-1"), "visit_date", "Visit", "%Y-%m-%d"),
			],
			fields: [
				f({
					kind: "hidden",
					id: "visit_date",
					caseWrite: { caseType: "patient", property: "visit_date" },
					default_value: "today()",
				}),
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === CODE,
			),
		).toBe(false);
	});

	it("passes on an UNKNOWN type — missing metadata never manufactures a finding", () => {
		const doc = moduleWith({
			columns: [
				dateColumn(testUuid("col-1"), "mystery", "Mystery", "%Y-%m-%d"),
			],
			fields: [
				f({
					kind: "hidden",
					id: "mystery",
					caseWrite: { caseType: "patient", property: "mystery" },
					default_value: "concat('a', 'b')",
				}),
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === CODE,
			),
		).toBe(false);
	});

	it("fires on a phone column over a standard datetime property", () => {
		const doc = moduleWith({
			columns: [phoneColumn(testUuid("col-1"), "date_opened", "Opened")],
			fields: [
				f({
					kind: "text",
					id: "case_name",
					label: proseText("Name"),
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
			],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some((e) => e.code === CODE && e.message.includes("date_opened")),
		).toBe(true);
	});
});

/*
 * The second reason a column cannot render its property, and the one
 * the type axis cannot express: an attachment-mode capture writes the
 * FILE to the case's attachment block and leaves the property's scalar
 * slot empty, so there is nothing to show at any type. `plain` — the
 * escape hatch the mismatch message recommends — is just as blank here.
 */
describe("a column over a property that holds an attachment", () => {
	const SLOT_CODE = "CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT";

	const attachmentWriter = (property: string): FieldSpec => ({
		kind: "image",
		id: "thepicture",
		label: proseText("Photo"),
		caseWrite: { caseType: "patient", property, mode: "attachment" },
	});

	it("refuses the column, whatever kind it is", () => {
		for (const column of [
			plainColumn(testUuid("col-1"), "photo", "Photo"),
			phoneColumn(testUuid("col-1"), "photo", "Photo"),
		]) {
			const doc = moduleWith({
				columns: [column],
				fields: [attachmentWriter("photo")],
			});
			const codes = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
				(e) => e.code,
			);
			expect(codes).toContain(SLOT_CODE);
		}
	});

	it("says so once, without also claiming a type mismatch", () => {
		const doc = moduleWith({
			columns: [phoneColumn(testUuid("col-1"), "photo", "Photo")],
			fields: [attachmentWriter("photo")],
		});
		const codes = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(e) => e.code,
		);

		expect(codes.filter((code) => code === SLOT_CODE)).toHaveLength(1);
		// Two findings over one column would have the author fix a type
		// that was never the problem.
		expect(codes).not.toContain(CODE);
	});

	it("leaves a URL-mode writer's property alone", () => {
		// The whole point of URL mode: the property holds a real string,
		// so every ordinary column reads it.
		const doc = moduleWith({
			columns: [plainColumn(testUuid("col-1"), "photo_url", "Photo")],
			fields: [
				{
					kind: "image",
					id: "thepicture",
					label: proseText("Photo"),
					caseWrite: {
						caseType: "patient",
						property: "photo_url",
						mode: "url",
					},
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).not.toContain(SLOT_CODE);
	});

	it("leaves the property alone when an ordinary field also writes it", () => {
		// A scalar writer means there IS a value; the attachment rides
		// alongside it rather than replacing it.
		const doc = moduleWith({
			columns: [plainColumn(testUuid("col-1"), "photo", "Photo")],
			fields: [
				attachmentWriter("photo"),
				{
					kind: "text",
					id: "photo_note",
					label: proseText("Note"),
					caseWrite: { caseType: "patient", property: "photo" },
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).not.toContain(SLOT_CODE);
	});
});
