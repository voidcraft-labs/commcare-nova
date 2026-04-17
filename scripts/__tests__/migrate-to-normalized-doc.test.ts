// scripts/__tests__/migrate-to-normalized-doc.test.ts
//
// Unit tests for the one-time Firestore migration that converts the legacy
// nested AppBlueprint shape to the normalized BlueprintDoc shape.
//
// Tests are pure — no Firestore connection required. The migration logic is
// exported from the script as `legacyAppBlueprintToDoc` specifically so it
// can be exercised here against a known fixture.

import { describe, expect, it } from "vitest";
import { legacyAppBlueprintToDoc } from "../migrate-to-normalized-doc";
import fixture from "./fixtures/legacy-blueprint.json";

// ---------------------------------------------------------------------------
// Fixture shape expectations (derived from the fixture JSON):
//   - 2 modules (module 1 has uuid; module 2 does NOT — uuid is minted)
//   - module 1: 2 forms (both have uuids)
//   - module 2: 2 forms (form 1 has uuid; form 2 does NOT — uuid is minted)
//   - module 1, form 1 (registration): 5 top-level questions
//       - 3 flat inputs (text, int, single_select)
//       - 1 group with 2 children
//       - 1 hidden field
//     = 5 direct children of form, 2 nested → 7 total field entries for this form
//   - module 1, form 2 (followup): 5 top-level questions
//       - single_select, text, image, repeat (with 2 children), hidden
//     = 5 direct children of form, 2 nested → 7 total field entries for this form
//   - module 2, form 1 (health_survey): 5 questions (all flat)
//   - module 2, form 2 (quick_check_in): 5 questions (all flat)
//
// Total field entities = 7 + 7 + 5 + 5 = 24
// ---------------------------------------------------------------------------

const EXPECTED_MODULE_COUNT = 2;
const EXPECTED_FORM_COUNT = 4;
const EXPECTED_FIELD_COUNT = 24;

describe("legacyAppBlueprintToDoc", () => {
	it("produces a BlueprintDoc with the correct number of modules", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		expect(Object.keys(doc.modules).length).toBe(EXPECTED_MODULE_COUNT);
	});

	it("produces a BlueprintDoc with the correct number of forms", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		expect(Object.keys(doc.forms).length).toBe(EXPECTED_FORM_COUNT);
	});

	it("flattens all fields (including nested group/repeat children) into doc.fields", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		expect(Object.keys(doc.fields).length).toBe(EXPECTED_FIELD_COUNT);
	});

	it("moduleOrder has one entry per module", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		expect(doc.moduleOrder.length).toBe(EXPECTED_MODULE_COUNT);
	});

	it("formOrder has one entry per module and correct form counts", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Both modules have 2 forms each.
		const formCounts = doc.moduleOrder.map(
			(mUuid) => doc.formOrder[mUuid]?.length ?? 0,
		);
		expect(formCounts).toEqual([2, 2]);
	});

	it("every fieldOrder key corresponds to a form UUID or a container field UUID", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);

		// Every key in fieldOrder must be either a form UUID or a field UUID.
		const formUuids = new Set(Object.keys(doc.forms));
		const fieldUuids = new Set(Object.keys(doc.fields));

		for (const parentKey of Object.keys(doc.fieldOrder)) {
			const isForm = formUuids.has(parentKey);
			const isField = fieldUuids.has(parentKey);
			expect(isForm || isField).toBe(true);
		}
	});

	it("every UUID referenced in fieldOrder values exists in doc.fields", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		const fieldUuids = new Set(Object.keys(doc.fields));

		for (const [, children] of Object.entries(doc.fieldOrder)) {
			for (const childUuid of children) {
				expect(fieldUuids.has(childUuid)).toBe(true);
			}
		}
	});

	it("fieldParent is NOT persisted — it is present but intentionally empty", () => {
		// `fieldParent` is a transient derived field; the script initializes it
		// as an empty map rather than omitting it so the BlueprintDoc type is
		// satisfied. Callers strip it before persisting to Firestore.
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		expect(doc.fieldParent).toBeDefined();
		expect(Object.keys(doc.fieldParent).length).toBe(0);
	});

	it("preserves existing UUIDs from the fixture", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);

		// Module 1 has a known UUID in the fixture.
		expect(doc.moduleOrder[0]).toBe("11111111-1111-1111-1111-111111111111");

		// Form 1 in module 1 has a known UUID.
		const m1Forms = doc.formOrder[doc.moduleOrder[0]];
		expect(m1Forms[0]).toBe("22222222-2222-2222-2222-222222222222");

		// A field in the registration form has a known UUID.
		const registrationFields = doc.fieldOrder[m1Forms[0]];
		expect(registrationFields[0]).toBe("aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
	});

	it("mints a UUID for the module that has none in the fixture", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Module 2 (survey module) has no uuid in the fixture — a fresh UUID
		// is minted. We can only assert it is a non-empty string, not predict it.
		const m2Uuid = doc.moduleOrder[1];
		expect(typeof m2Uuid).toBe("string");
		expect(m2Uuid.length).toBeGreaterThan(0);
		// Must NOT be the module 1 UUID.
		expect(m2Uuid).not.toBe("11111111-1111-1111-1111-111111111111");
	});

	it("mints a UUID for the form that has none in the fixture", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Module 2, form 2 ("Quick Check-In") has no uuid in the fixture.
		const m2Uuid = doc.moduleOrder[1];
		const m2Forms = doc.formOrder[m2Uuid];
		// Form 1 in module 2 has a known UUID.
		expect(m2Forms[0]).toBe("44444444-4444-4444-4444-444444444444");
		// Form 2 is the minted one — non-empty, non-null, not the known UUID.
		const mintedFormUuid = m2Forms[1];
		expect(typeof mintedFormUuid).toBe("string");
		expect(mintedFormUuid.length).toBeGreaterThan(0);
		expect(mintedFormUuid).not.toBe("44444444-4444-4444-4444-444444444444");
	});

	it("translates close_condition.question → close_condition.field", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Follow-up form (module 1, form 2) has a close_condition in the fixture.
		const m1Uuid = doc.moduleOrder[0];
		const followupFormUuid = doc.formOrder[m1Uuid][1];
		const followupForm = doc.forms[followupFormUuid];

		expect(followupForm.closeCondition).toBeDefined();
		// The normalized key is `field`, not `question`.
		expect(followupForm.closeCondition?.field).toBe("discharge_status");
		expect(followupForm.closeCondition?.answer).toBe("discharged");
		expect(followupForm.closeCondition?.operator).toBe("=");
		// TypeScript guard: there should be no `question` key on the normalized shape.
		// @ts-expect-error — `question` does not exist on CloseCondition
		expect(followupForm.closeCondition?.question).toBeUndefined();
	});

	it("translates form_link target indices to UUIDs", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Follow-up form (module 1, form 2) has a form_link targeting
		// moduleIndex: 0, formIndex: 0 in the fixture.
		const m1Uuid = doc.moduleOrder[0];
		const followupFormUuid = doc.formOrder[m1Uuid][1];
		const followupForm = doc.forms[followupFormUuid];

		expect(followupForm.formLinks).toHaveLength(1);
		const link = followupForm.formLinks?.[0];
		if (!link) throw new Error("expected form link");

		// Target type: form — must now reference UUIDs not indices.
		expect(link.target.type).toBe("form");
		// moduleIndex 0 → moduleOrder[0]
		expect(
			(link.target as { type: "form"; moduleUuid: string; formUuid: string })
				.moduleUuid,
		).toBe("11111111-1111-1111-1111-111111111111");
		// formIndex 0 within that module → formOrder[m1Uuid][0] = registration form
		expect(
			(link.target as { type: "form"; moduleUuid: string; formUuid: string })
				.formUuid,
		).toBe("22222222-2222-2222-2222-222222222222");
	});

	it("translates case_property_on → case_property on fields", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// The first field in the registration form has case_property_on: "name".
		const m1Uuid = doc.moduleOrder[0];
		const regFormUuid = doc.formOrder[m1Uuid][0];
		const firstFieldUuid = doc.fieldOrder[regFormUuid][0];
		const firstField = doc.fields[firstFieldUuid];

		// Normalized shape uses `case_property`; legacy used `case_property_on`.
		expect((firstField as Record<string, unknown>).case_property).toBe("name");
		// The legacy key must NOT be present.
		expect(
			(firstField as Record<string, unknown>).case_property_on,
		).toBeUndefined();
	});

	it("handles group fields with nested children correctly", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Registration form has a group field ("contact_group") with 2 children.
		const m1Uuid = doc.moduleOrder[0];
		const regFormUuid = doc.formOrder[m1Uuid][0];

		// Fourth field in the registration form is the group.
		const groupUuid = doc.fieldOrder[regFormUuid][3];
		const groupField = doc.fields[groupUuid];
		expect(groupField.kind).toBe("group");

		// The group's children are tracked in fieldOrder under the group's UUID.
		expect(doc.fieldOrder[groupUuid]).toHaveLength(2);

		// Each child UUID must exist in doc.fields.
		for (const childUuid of doc.fieldOrder[groupUuid]) {
			expect(doc.fields[childUuid]).toBeDefined();
			expect(doc.fields[childUuid].kind).toBe("text");
		}
	});

	it("handles repeat fields with nested children correctly", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		// Follow-up form has a repeat field ("medications") with 2 children.
		const m1Uuid = doc.moduleOrder[0];
		const followupFormUuid = doc.formOrder[m1Uuid][1];

		// Fourth field in the follow-up form is the repeat.
		const repeatUuid = doc.fieldOrder[followupFormUuid][3];
		const repeatField = doc.fields[repeatUuid];
		expect(repeatField.kind).toBe("repeat");

		// Children are tracked in fieldOrder under the repeat's UUID.
		expect(doc.fieldOrder[repeatUuid]).toHaveLength(2);
	});

	it("sets correct appId, appName, and top-level metadata", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		expect(doc.appId).toBe("test-app");
		expect(doc.appName).toBe("Patient Care App");
		expect(doc.connectType).toBeNull();
		expect(doc.caseTypes).toHaveLength(1);
		expect(doc.caseTypes?.[0]?.name).toBe("patient");
	});

	it("module metadata is correctly mapped from camelCase", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		const m1Uuid = doc.moduleOrder[0];
		const module1 = doc.modules[m1Uuid];
		expect(module1.name).toBe("Patient Management");
		expect(module1.caseType).toBe("patient");
		expect(module1.caseListOnly).toBe(false);
		expect(module1.purpose).toBe("Manage patient records");
		expect(module1.caseListColumns).toHaveLength(2);
	});

	it("form metadata is correctly mapped from camelCase", () => {
		const doc = legacyAppBlueprintToDoc("test-app", fixture);
		const m1Uuid = doc.moduleOrder[0];
		const regFormUuid = doc.formOrder[m1Uuid][0];
		const regForm = doc.forms[regFormUuid];
		expect(regForm.name).toBe("Patient Registration");
		expect(regForm.type).toBe("registration");
		expect(regForm.purpose).toBe("Register a new patient");
	});

	it("strips wire-shape keys that don't belong on the target field kind", () => {
		// The walker sprays `label: q.label ?? ""` onto every field regardless
		// of kind — including `hidden`, whose schema has no `label`. The Zod
		// parse step must strip those stray keys so Firestore never receives
		// shape-invalid field records.
		const doc = legacyAppBlueprintToDoc("test-app", fixture);

		// Collect every hidden field in the migrated doc.
		const hiddenFields = Object.values(doc.fields).filter(
			(f) => f.kind === "hidden",
		);
		expect(hiddenFields.length).toBeGreaterThan(0);

		for (const hidden of hiddenFields) {
			// `label` is not part of the hidden-field schema — it must NOT
			// survive the migration.
			expect(hidden).not.toHaveProperty("label");
		}
	});

	it("is idempotent — calling twice produces the same structure (same UUIDs preserved)", () => {
		// UUIDs that already existed in the fixture should be preserved on
		// every call. Only freshly minted UUIDs will differ between calls.
		const doc1 = legacyAppBlueprintToDoc("test-app", fixture);
		const doc2 = legacyAppBlueprintToDoc("test-app", fixture);

		// Known UUIDs from the fixture must be stable across calls.
		expect(doc1.moduleOrder[0]).toBe(doc2.moduleOrder[0]);
		expect(doc1.formOrder[doc1.moduleOrder[0]][0]).toBe(
			doc2.formOrder[doc2.moduleOrder[0]][0],
		);

		// Field counts must be identical.
		expect(Object.keys(doc1.fields).length).toBe(
			Object.keys(doc2.fields).length,
		);
	});
});
