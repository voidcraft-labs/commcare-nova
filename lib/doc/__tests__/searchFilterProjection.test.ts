import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { deriveSearchFilter } from "@/lib/doc/hooks/useSearchFilter";
import {
	type BlueprintDoc,
	collectLocalizedTranslationUnits,
	proseText,
} from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";
import { buildFixture, withSpanishFieldLabel } from "./searchFilterFixture";

function derive(doc: BlueprintDoc, query: string, language = "eng") {
	assertAdmittedDoc(doc);
	return deriveSearchFilter(query, {
		...doc,
		userProperties: doc.userProperties,
		localizedValues: new Map(
			collectLocalizedTranslationUnits(doc, language).map((unit) => [
				unit.id,
				unit.effective,
			]),
		),
	});
}
describe("search visibility and highlight projection", () => {
	it("returns null for an empty query", () => {
		const doc = buildFixture();
		const result = derive(doc, "");
		expect(result).toBeNull();
	});
	it("returns null for a whitespace-only query", () => {
		const doc = buildFixture();
		const result = derive(doc, "   ");
		expect(result).toBeNull();
	});
	it("matches a module name and marks module visible", () => {
		const doc = buildFixture();
		const result = derive(doc, "registration");
		const r = result;
		expect(r).not.toBeNull();
		if (!r) return;
		const MOD = testUuid("module-aaaa-0000-0000-000000000000");
		expect(r.visibleModuleUuids.has(MOD)).toBe(true);
		// Matches are keyed by stable authored identity, never array position.
		expect(r.matchMap.get(MOD)).toBeDefined();
		// Module-name match alone should force-expand the module so its forms
		// remain visible when the user drills in.
		expect(r.forceExpand.has(MOD)).toBe(true);
	});
	it("matches a field label and force-expands its parent form", () => {
		const doc = buildFixture();
		const result = derive(doc, "age");
		const r = result;
		expect(r).not.toBeNull();
		if (!r) return;

		// Q_AGE has label "Age in Years" → visible.
		const Q_AGE = testUuid("q-age-0000-0000-0000-000000000000");
		expect(r.visibleFieldUuids.has(Q_AGE)).toBe(true);

		// The form containing the match must be visible.
		const FORM = testUuid("form-bbbb-0000-0000-000000000000");
		expect(r.visibleFormUuids.has(FORM)).toBe(true);

		// The form's UUID must be force-expanded so the match shows.
		expect(r.forceExpand.has(FORM)).toBe(true);
	});
	it("retains and expands a root ancestor when its submenu matches", () => {
		const doc = buildFixture();
		const rootUuid = doc.moduleOrder[0];
		const childUuid = testUuid("module-child-0000-0000-000000000000");
		doc.modules[childUuid] = {
			uuid: childUuid,
			id: "visits",
			name: "Follow-up visits",
			parentModuleUuid: rootUuid,
		};
		doc.moduleOrder.push(childUuid);
		const childForm = testUuid("child-form");
		const childQuestion = testUuid("child-question");
		doc.forms[childForm] = {
			uuid: childForm,
			id: "visit",
			name: "Visit",
			type: "survey",
		};
		doc.fields[childQuestion] = {
			uuid: childQuestion,
			id: "note",
			kind: "text",
			label: proseText("Note"),
		};
		doc.formOrder[childUuid] = [childForm];
		doc.fieldOrder[childForm] = [childQuestion];
		doc.fieldParent[childQuestion] = childForm;
		const result = derive(doc, "follow-up");
		const search = result;
		expect(search?.visibleModuleUuids.has(childUuid)).toBe(true);
		expect(search?.visibleModuleUuids.has(rootUuid)).toBe(true);
		expect(search?.forceExpand.has(rootUuid)).toBe(true);
	});
	it("retains every field-group ancestor of a deep match", () => {
		const doc = buildFixture();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const groupUuid = testUuid("q-group-0000-0000-0000-000000000000");
		const childUuid = testUuid("q-child-0000-0000-0000-000000000000");
		doc.fields[groupUuid] = {
			uuid: groupUuid,
			id: "details",
			kind: "group",
			label: proseText("Details"),
		};
		doc.fields[childUuid] = {
			uuid: childUuid,
			id: "remote_note",
			kind: "text",
			label: proseText("Remote note"),
		};
		doc.fieldOrder[formUuid].push(groupUuid);
		doc.fieldOrder[groupUuid] = [childUuid];
		doc.fieldParent[groupUuid] = formUuid;
		doc.fieldParent[childUuid] = groupUuid;
		const result = derive(doc, "remote");
		const search = result;
		expect(search?.visibleFieldUuids.has(childUuid)).toBe(true);
		expect(search?.visibleFieldUuids.has(groupUuid)).toBe(true);
		expect(search?.forceExpand.has(groupUuid)).toBe(true);
	});
	it("matches and highlights the selected language's visible field label", () => {
		const doc = withSpanishFieldLabel(buildFixture());
		const result = derive(doc, "nombre completo", "spa");
		const r = result;
		expect(r).not.toBeNull();
		if (r === null) return;
		const fieldUuid = testUuid("q-name-0000-0000-0000-000000000000");
		expect(r.visibleFieldUuids.has(fieldUuid)).toBe(true);
		expect(r.matchMap.get(fieldUuid)).toEqual([[0, 15]]);
	});
	it("records separate match indices for label vs id hits", () => {
		const doc = buildFixture();
		// "patient" hits BOTH the label "Patient Full Name" AND the id
		// "patient_name". The filter should record both under distinct keys.
		const result = derive(doc, "patient");
		const r = result;
		expect(r).not.toBeNull();
		if (!r) return;

		// Both the label and id matches should produce entries — the id entry
		// is keyed with `__id` suffix so the row can render "(id)" separately.
		const fieldUuid = testUuid("q-name-0000-0000-0000-000000000000");
		expect(r.matchMap.get(fieldUuid)).toBeDefined();
		expect(r.matchMap.get(`${fieldUuid}__id`)).toBeDefined();
	});
	it("produces empty visibility sets when no entity matches", () => {
		const doc = buildFixture();
		const result = derive(doc, "zzznomatchzzz");
		const r = result;
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.visibleModuleUuids.size).toBe(0);
		expect(r.visibleFormUuids.size).toBe(0);
		expect(r.visibleFieldUuids.size).toBe(0);
	});
});
