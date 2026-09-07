/** Structural media identity projection and remapping over admitted documents.
 * Explicit expected identities and whole-document substitution are independent
 * of the production walker; these examples do not prove every future carrier
 * or a real cross-Project storage copy. */

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { proseText } from "@/lib/domain/prose";
import { blueprintDocSchema } from "../blueprint";
import { builtinIconRef } from "../builtinIcons";
import {
	asWalkableDoc,
	collectAssetRefs,
	collectAuthoredAssetRefs,
	remapAssetRefs,
} from "../mediaRefs";
import { plainColumn } from "../modules";

const BUILTIN_REF = builtinIconRef("household");
const MOD_A = testUuid("mod-a");
const MOD_B = testUuid("mod-b");
const FORM = testUuid("form-1");
const TEXT_FIELD = testUuid("field-text");
const SELECT_FIELD = testUuid("field-select");
const COLUMN = testUuid("col-1");
const media = testMediaAssetId;

function admittedPersisted(input: unknown) {
	return toPersistableDoc(
		expectAdmittedDoc(
			hydratePersistedBlueprint(blueprintDocSchema.parse(input)),
		),
	);
}

/** A blueprint with a distinct asset id in EVERY slot `walkAssetRefs` covers:
 *  app logo; a caseListOnly module's icon/audioLabel + caseListConfig
 *  icon/audioLabel + an image-map column's mapping; a regular module's
 *  icon/audioLabel; a form's icon/audioLabel; all four field media bundles (label has image/audio/video); and select-option media. Plus a built-in icon ref to
 *  prove pass-through. */
function fixtureDoc() {
	return admittedPersisted({
		appId: "app-1",
		appName: "Fixture",
		connectType: null,
		caseTypes: [{ name: "patient", properties: [] }],
		logo: media("logo"),
		moduleOrder: [MOD_A, MOD_B],
		formOrder: { [MOD_A]: [], [MOD_B]: [FORM] },
		fieldOrder: { [FORM]: [TEXT_FIELD, SELECT_FIELD] },
		modules: {
			[MOD_A]: {
				uuid: MOD_A,
				id: "case_list",
				name: "Case list",
				caseListOnly: true,
				caseType: "patient",
				icon: media("mod-a-icon"),
				audioLabel: media("mod-a-audio"),
				caseListConfig: {
					columns: [
						{
							uuid: COLUMN,
							kind: "image-map",
							field: "status",
							header: "Status",
							mapping: [
								{ value: "open", assetId: media("imgmap-1") },
								{ value: "closed", assetId: media("imgmap-2") },
							],
						},
					],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
					icon: media("cl-icon"),
					audioLabel: media("cl-audio"),
				},
			},
			[MOD_B]: {
				uuid: MOD_B,
				id: "intake_module",
				name: "Intake",
				icon: BUILTIN_REF,
				audioLabel: media("mod-b-audio"),
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "intake",
				name: "Intake",
				type: "survey",
				icon: media("form-icon"),
				audioLabel: media("form-audio"),
			},
		},
		fields: {
			[TEXT_FIELD]: {
				kind: "text",
				uuid: TEXT_FIELD,
				id: "patient_name",
				label: proseText("Name"),
				label_media: {
					image: media("lbl-img"),
					audio: media("lbl-aud"),
					video: media("lbl-vid"),
				},
				hint_media: { image: media("hint-img") },
				help_media: { audio: media("help-aud") },
				validate_msg_media: { video: media("val-vid") },
			},
			[SELECT_FIELD]: {
				kind: "single_select",
				uuid: SELECT_FIELD,
				id: "symptom",
				label: proseText("Symptom"),
				optionsSource: {
					kind: "inline",
					options: [
						{
							uuid: testUuid("option-fever"),
							value: "fever",
							label: proseText("Fever"),
							media: {
								image: media("opt-img"),
								audio: media("opt-aud"),
							},
						},
						{
							uuid: testUuid("option-cough"),
							value: "cough",
							label: proseText("Cough"),
						},
					],
				},
			},
		},
	});
}

describe("remapAssetRefs", () => {
	it("remaps the fixture's independently named media identities and preserves every other value", () => {
		const doc = fixtureDoc();
		const names = [
			"logo",
			"mod-a-icon",
			"mod-a-audio",
			"cl-icon",
			"cl-audio",
			"imgmap-1",
			"imgmap-2",
			"mod-b-audio",
			"form-icon",
			"form-audio",
			"lbl-img",
			"lbl-aud",
			"lbl-vid",
			"hint-img",
			"help-aud",
			"val-vid",
			"opt-img",
			"opt-aud",
		];
		const fullMap = new Map(
			names.map((name) => [media(name), media(`${name}-moved`)]),
		);
		expect(collectAssetRefs(asWalkableDoc(doc))).toEqual(
			new Set([BUILTIN_REF, ...fullMap.keys()]),
		);
		const directExpected: unknown = JSON.parse(
			JSON.stringify(doc),
			(_key, value: unknown) => {
				for (const [from, to] of fullMap) if (value === from) return to;
				return value;
			},
		);
		const remapped = remapAssetRefs(doc, fullMap);
		expect(remapped).toEqual(directExpected);
		admittedPersisted(remapped);
	});

	it("leaves the input doc untouched", () => {
		const doc = fixtureDoc();
		const before = structuredClone(doc);
		remapAssetRefs(doc, new Map([[media("logo"), media("logo__M")]]));
		expect(doc).toEqual(before);
	});

	it("passes through ids absent from the map (built-in refs, partial maps)", () => {
		const doc = fixtureDoc();
		// Map only the logo; everything else — including the built-in icon ref —
		// must survive unchanged.
		const remappedLogo = media("logo__M");
		const logo = media("logo");
		const optionImage = media("opt-img");
		const remapped = remapAssetRefs(doc, new Map([[logo, remappedLogo]]));
		const ids = collectAssetRefs(asWalkableDoc(remapped));
		expect(ids.has(remappedLogo)).toBe(true);
		expect(ids.has(logo)).toBe(false);
		expect(ids.has(BUILTIN_REF)).toBe(true); // built-in untouched
		expect(ids.has(optionImage)).toBe(true); // unmapped real id untouched
	});

	it("returns the same doc reference when the map is empty", () => {
		const doc = fixtureDoc();
		expect(remapAssetRefs(doc, new Map())).toBe(doc);
	});
});

/** A module that is NOT caseListOnly but still carries a caseListConfig icon —
 *  the residue of having once been case-list-only. The render-gated walk omits
 *  it, but it persists in the doc (and remapAssetRefs rewrites it un-gated). */
function docWithDormantCaseListIcon() {
	const moduleUuid = testUuid("mod-x");
	const formUuid = testUuid("form-x");
	return admittedPersisted({
		appId: "app-2",
		appName: "Dormant",
		connectType: null,
		caseTypes: [{ name: "patient", properties: [] }],
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [TEXT_FIELD] },
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "m",
				name: "M",
				caseListOnly: false,
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(COLUMN, "case_name", "Name")],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
					icon: media("dormant-cl-icon"),
					audioLabel: media("dormant-cl-audio"),
				},
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "f",
				name: "F",
				type: "followup",
			},
		},
		fields: {
			[TEXT_FIELD]: {
				uuid: TEXT_FIELD,
				id: "note",
				kind: "text",
				label: proseText("Note"),
			},
		},
	});
}

function docWithDormantImageMap() {
	const moduleUuid = testUuid("mod-x");
	const columnUuid = testUuid("col-dormant");
	return admittedPersisted({
		appId: "app-3",
		appName: "Dormant image",
		connectType: null,
		caseTypes: [{ name: "patient", properties: [] }],
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [] },
		fieldOrder: {},
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "m",
				name: "M",
				caseListOnly: true,
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(COLUMN, "case_name", "Name"),
						{
							uuid: columnUuid,
							kind: "image-map",
							field: "status",
							header: "Old status image",
							visibleInList: false,
							visibleInDetail: false,
							mapping: [{ value: "open", assetId: media("dormant-image") }],
						},
					],
					listColumnOrder: [COLUMN, columnUuid],
					detailColumnOrder: [COLUMN, columnUuid],
					searchInputs: [],
				},
			},
		},
		forms: {},
		fields: {},
	});
}

describe("collectAuthoredAssetRefs", () => {
	it("carries a non-caseListOnly module's caseListConfig media the gated walk drops", () => {
		const doc = asWalkableDoc(docWithDormantCaseListIcon());
		// The render-gated walk omits it (it doesn't render on a non-caseListOnly
		// module), so a move keyed on it would strand the ref...
		const gated = collectAssetRefs(doc);
		expect(gated.has(media("dormant-cl-icon"))).toBe(false);
		expect(gated.has(media("dormant-cl-audio"))).toBe(false);
		// ...but the movable set carries it, so the move copies + repoints it.
		const movable = collectAuthoredAssetRefs(doc);
		expect(movable.has(media("dormant-cl-icon"))).toBe(true);
		expect(movable.has(media("dormant-cl-audio"))).toBe(true);
	});

	it("is a superset of the gated walk (never drops a rendered ref)", () => {
		const doc = asWalkableDoc(fixtureDoc());
		const movable = collectAuthoredAssetRefs(doc);
		for (const id of collectAssetRefs(doc)) {
			expect(movable.has(id)).toBe(true);
		}
	});

	it("keeps dormant image-map media movable without validating or emitting it", () => {
		const doc = asWalkableDoc(docWithDormantImageMap());
		expect(collectAssetRefs(doc).has(media("dormant-image"))).toBe(false);
		expect(collectAuthoredAssetRefs(doc).has(media("dormant-image"))).toBe(
			true,
		);
	});
});
