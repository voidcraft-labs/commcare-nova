/**
 * The one placement verdict every surface asks before a field lands, and
 * the readers behind it. Every `ok` here is also a shape the commit gate
 * admits, and every refusal is one it would refuse — `formSectionMutations`
 * tests pin the planners' output through the gate; this file pins the
 * verdict's answers and its three sentences.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	FIELD_PLACEMENT_MESSAGES,
	fieldPlacementVerdict,
	formIsSectioned,
	formOfField,
	formSectionsOf,
	landingSectionOf,
	sectionOf,
	subtreeHasUserRepeat,
} from "@/lib/doc/formSectionVerdicts";
import { proseText } from "@/lib/domain/prose";

const FORM = testUuid("frm-sectioned");
const FLAT = testUuid("frm-flat");
const S1 = testUuid("sec-1");
const S2 = testUuid("sec-2");
const NAME = testUuid("fld-name");
const AGE = testUuid("fld-age");
const GROUP = testUuid("fld-group");
const PHONE = testUuid("fld-phone");
const VISIT_DATE = testUuid("fld-visit-date");
const FLAT_A = testUuid("fld-flat-a");
const FLAT_GROUP = testUuid("fld-flat-group");
const FLAT_REPEAT = testUuid("fld-flat-repeat");

/**
 * Sectioned: [S1: name, group(phone)] [S2: age]
 * Flat: a, group(), repeat visits (user-controlled, holds visit_date)
 */
function fixture() {
	return buildDoc({
		appName: "Verdicts",
		modules: [
			{
				name: "M",
				forms: [
					{
						uuid: FORM,
						name: "Sectioned",
						type: "survey",
						fields: [
							f({
								kind: "section",
								uuid: S1,
								id: "s1",
								label: proseText("One"),
								children: [
									f({ kind: "text", uuid: NAME, id: "name" }),
									f({
										kind: "group",
										uuid: GROUP,
										id: "g",
										children: [f({ kind: "text", uuid: PHONE, id: "phone" })],
									}),
								],
							}),
							f({
								kind: "section",
								uuid: S2,
								id: "s2",
								children: [f({ kind: "int", uuid: AGE, id: "age" })],
							}),
						],
					},
					{
						uuid: FLAT,
						name: "Flat",
						type: "survey",
						fields: [
							f({ kind: "text", uuid: FLAT_A, id: "a" }),
							f({ kind: "group", uuid: FLAT_GROUP, id: "g", children: [] }),
							f({
								kind: "repeat",
								uuid: FLAT_REPEAT,
								id: "visits",
								repeat_mode: "user_controlled",
								children: [f({ kind: "date", uuid: VISIT_DATE, id: "d" })],
							}),
						],
					},
				],
			},
		],
	});
}

describe("section readers", () => {
	it("list a form's root sections in page order and say whether it is sectioned", () => {
		const doc = fixture();
		expect(formSectionsOf(doc, FORM)).toEqual([S1, S2]);
		expect(formIsSectioned(doc, FORM)).toBe(true);
		expect(formSectionsOf(doc, FLAT)).toEqual([]);
		expect(formIsSectioned(doc, FLAT)).toBe(false);
	});

	it("find the page a field is on, at any depth, and the form it belongs to", () => {
		const doc = fixture();
		expect(sectionOf(doc, NAME)).toBe(S1);
		expect(sectionOf(doc, PHONE)).toBe(S1);
		expect(sectionOf(doc, AGE)).toBe(S2);
		expect(sectionOf(doc, S1)).toBeUndefined();
		expect(sectionOf(doc, FLAT_A)).toBeUndefined();
		expect(landingSectionOf(doc, S2)).toBe(S2);
		expect(landingSectionOf(doc, GROUP)).toBe(S1);
		expect(landingSectionOf(doc, FLAT_GROUP)).toBeUndefined();
		expect(formOfField(doc, PHONE)).toBe(FORM);
		expect(formOfField(doc, FLAT_REPEAT)).toBe(FLAT);
	});

	it("see an add-entries repeat anywhere below a field", () => {
		const doc = fixture();
		expect(subtreeHasUserRepeat(doc, FLAT_REPEAT)).toBe(true);
		expect(subtreeHasUserRepeat(doc, VISIT_DATE)).toBe(false);
		expect(subtreeHasUserRepeat(doc, FLAT_GROUP)).toBe(false);
		expect(subtreeHasUserRepeat(doc, GROUP)).toBe(false);
	});
});

describe("fieldPlacementVerdict", () => {
	it("lets a question land inside a section, and refuses it at a sectioned root", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, { kind: "text", toParentUuid: S2 }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_A,
				kind: "text",
				toParentUuid: S1,
			}),
		).toEqual({ ok: true });
		const loose = fieldPlacementVerdict(doc, {
			kind: "text",
			toParentUuid: FORM,
		});
		expect(loose).toEqual({
			ok: false,
			reason: "loose-field-in-sectioned-form",
			message: FIELD_PLACEMENT_MESSAGES["loose-field-in-sectioned-form"],
		});
	});

	it("lets anything land at the root of a single-page form", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, { kind: "text", toParentUuid: FLAT }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: FLAT }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, {
				kind: "repeat",
				toParentUuid: FLAT,
				subtreeHasUserRepeat: true,
			}),
		).toEqual({ ok: true });
	});

	it("keeps a section at the top level of its own form", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: FORM }),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, {
				uuid: S1,
				kind: "section",
				toParentUuid: FORM,
			}),
		).toEqual({ ok: true });
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: GROUP }).ok,
		).toBe(false);
		expect(
			fieldPlacementVerdict(doc, { kind: "section", toParentUuid: S1 }),
		).toMatchObject({ ok: false, reason: "section-not-root" });
		expect(
			fieldPlacementVerdict(doc, {
				uuid: S1,
				kind: "section",
				toParentUuid: FLAT,
			}),
		).toMatchObject({ ok: false, reason: "section-other-form" });
	});

	it("refuses an add-entries repeat under a section, at any depth, and allows a bound one", () => {
		const doc = fixture();
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_REPEAT,
				kind: "repeat",
				toParentUuid: S1,
			}),
		).toMatchObject({ ok: false, reason: "user-repeat-in-section" });
		// Into a group that sits on a page: still a page.
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_REPEAT,
				kind: "repeat",
				toParentUuid: GROUP,
			}),
		).toMatchObject({ ok: false, reason: "user-repeat-in-section" });
		// A new repeat: the caller says what it is.
		expect(
			fieldPlacementVerdict(doc, {
				kind: "repeat",
				toParentUuid: S1,
				subtreeHasUserRepeat: true,
			}).ok,
		).toBe(false);
		expect(
			fieldPlacementVerdict(doc, {
				kind: "repeat",
				toParentUuid: S1,
				subtreeHasUserRepeat: false,
			}),
		).toEqual({ ok: true });
		// A group carrying one moves with it.
		expect(
			fieldPlacementVerdict(doc, {
				uuid: FLAT_GROUP,
				kind: "group",
				toParentUuid: S2,
			}),
		).toEqual({ ok: true });
	});
});
