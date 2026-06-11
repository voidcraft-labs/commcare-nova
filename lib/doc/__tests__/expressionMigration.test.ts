/**
 * The migration byte-identity proof: converting a legacy doc's string
 * expression slots to ASTs changes ZERO emitted wire bytes.
 *
 * The comparison is exact, not approximate: every expression reader is
 * shape-driven (a string slot projects verbatim), so the current
 * code's emission of a LEGACY doc is byte-for-byte what the string-era
 * code emitted — making `emit(legacy) === emit(migrate(legacy))` a
 * true pre/post-migration pin, held over the XForm XML of every form
 * and the whole HQ-JSON expansion.
 *
 * The legacy fixtures cover the reference spellings, whitespace
 * shapes, dangling refs, transitional `#case/…` refs, and a
 * syntax-broken expression (which converts to one opaque text run).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";

// HQ unique_ids/xmlns are random per expansion — pin them to a
// deterministic counter so the pre/post comparison is over CONTENT
// bytes, exactly the spec's deterministic-id-factory regression shape.
let idCounter = 0;
vi.mock("@/lib/commcare/ids", () => ({
	genHexId: () => `${(++idCounter).toString(16).padStart(40, "0")}`,
	genShortId: () => `${(++idCounter).toString(16).padStart(16, "0")}`,
}));

beforeEach(() => {
	idCounter = 0;
});

import { buildXForm } from "@/lib/commcare/xform";
import { migrateDocExpressions } from "@/lib/doc/expressionMigration";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	asUuid,
	FIELD_REFERENCE_SLOTS,
	isXPathExpression,
	printXPath,
	readSlotValues,
	rewriteSlotValues,
	xpathPrintContext,
} from "@/lib/domain";

/** A reference-rich doc whose expression slots exercise every leaf
 *  classification. `buildDoc` stores them as ASTs (the canonical
 *  shape); `legacyize` prints them back to the string-era shape. */
function richDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Migration Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "int",
								id: "age",
								label: "Age",
								case_property_on: "patient",
								validate: ". >= 0 and . <= 120",
								required: "true()",
							}),
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "group",
								id: "grp",
								children: [
									f({
										kind: "text",
										id: "inner",
										label: "Inner",
										relevant: "#form/age > 17 and /data/age != ''",
									}),
								],
							}),
							f({
								kind: "hidden",
								id: "age_band",
								calculate: "if(#form/age >= 18, 'adult', \"minor\")",
							}),
							f({
								kind: "hidden",
								id: "spaced",
								calculate: "/ data / grp / inner",
							}),
							f({
								kind: "hidden",
								id: "dangler",
								calculate: "#form/never_existed + 1",
							}),
							f({
								kind: "hidden",
								id: "broken",
								// Unparseable on purpose — converts to one opaque run.
								default_value: "if(#form/age",
							}),
							f({
								kind: "text",
								id: "notes",
								label: "Notes",
								default_value: "concat('a', \"b\")",
								relevant: "#patient/age > 0 and #user/role != ''",
							}),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "status",
								label: "Status",
								relevant: "#case/age > 1",
								case_property_on: "patient",
							}),
						],
					},
					{
						name: "Close case",
						type: "close",
						closeCondition: { field: "outcome", answer: "deceased" },
						fields: [
							f({
								kind: "single_select",
								id: "outcome",
								label: "Outcome",
								options: [
									{ value: "deceased", label: "Deceased" },
									{ value: "moved", label: "Moved" },
								],
							}),
						],
					},
				],
			},
		],
	});
}

const AST_SLOT_PATHS = FIELD_REFERENCE_SLOTS.filter(
	(slot) => slot.kind === "xpath-ast",
).map((slot) => slot.path);

/** Project every AST slot back to its printed string, and every
 *  close-condition uuid back to its field id — the stored shape a
 *  string-era doc carried. */
function legacyize(doc: BlueprintDoc): BlueprintDoc {
	const ctx = xpathPrintContext(doc);
	for (const field of Object.values(doc.fields)) {
		for (const path of AST_SLOT_PATHS) {
			rewriteSlotValues(field, path, (value) =>
				isXPathExpression(value) ? printXPath(value, ctx) : value,
			);
		}
	}
	for (const form of Object.values(doc.forms)) {
		if (form.closeCondition) {
			form.closeCondition.field = asUuid(
				doc.fields[form.closeCondition.field]?.id ?? form.closeCondition.field,
			);
		}
	}
	return doc;
}

function emitAll(doc: BlueprintDoc): string {
	// Both emissions draw the same pinned id sequence.
	idCounter = 0;
	const xforms = Object.keys(doc.forms)
		.sort()
		.map((formUuid) =>
			buildXForm(doc, formUuid as never, {
				xmlns: `http://openrosa.org/formdesigner/${formUuid}`,
			}),
		);
	return `${JSON.stringify(expandDoc(doc))}\n${xforms.join("\n")}`;
}

describe("expression migration — byte identity", () => {
	it("emits byte-identical wire output before and after migration", () => {
		const legacy = legacyize(richDoc());
		const before = emitAll(legacy);

		const migrated = structuredClone(legacy);
		const result = migrateDocExpressions(migrated);
		expect(result.failures).toEqual([]);
		expect(result.converted).toBeGreaterThanOrEqual(9);
		expect(result.closeRefsConverted).toBe(1);
		expect(result.unresolvedCloseRefs).toEqual([]);

		expect(emitAll(migrated)).toBe(before);
	});

	it("converts the close-condition ref to the checked field's uuid", () => {
		const migrated = legacyize(richDoc());
		migrateDocExpressions(migrated);
		const closeForm = Object.values(migrated.forms).find(
			(form) => form.type === "close",
		);
		const outcome = Object.values(migrated.fields).find(
			(field) => field.id === "outcome",
		);
		expect(closeForm?.closeCondition?.field).toBe(outcome?.uuid);
	});

	it("converts every string slot to the AST shape (no dual storage left)", () => {
		const migrated = legacyize(richDoc());
		migrateDocExpressions(migrated);
		for (const field of Object.values(migrated.fields)) {
			for (const path of AST_SLOT_PATHS) {
				for (const entry of readSlotValues(field, path)) {
					expect(isXPathExpression(entry.value)).toBe(true);
				}
			}
		}
	});

	it("resolves identity at conversion — a post-migration rename reaches the printed text", () => {
		const migrated = legacyize(richDoc());
		migrateDocExpressions(migrated);
		const inner = Object.values(migrated.fields).find(
			(field) => field.id === "inner",
		);
		const age = Object.values(migrated.fields).find(
			(field) => field.id === "age",
		);
		if (!inner || !age) throw new Error("fixture fields missing");
		age.id = "years";
		expect(
			printXPath(
				(inner as { relevant?: never }).relevant as never,
				xpathPrintContext(migrated),
			),
		).toBe("#form/years > 17 and /data/years != ''");
	});
});
