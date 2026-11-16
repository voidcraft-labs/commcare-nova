/** Structural media identity projection and remapping over admitted documents.
 * Explicit expected identities and whole-document substitution are independent
 * of the production walker; these examples do not prove every future carrier
 * or a real cross-Project storage copy. */

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
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
	describeCarrier,
	remapAssetRefs,
	walkAssetRefs,
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
 *  app logo; a bare case list module's icon/audioLabel + its case list menu
 *  entry's icon/audioLabel + an image-map column's mapping; a regular module's
 *  icon/audioLabel; a form's icon/audioLabel; all four field media bundles (label has image/audio/video); and select-option media. Plus a built-in icon ref to
 *  prove pass-through. */
function fixtureDoc() {
	return admittedPersisted({
		appId: "app-1",
		appName: "Fixture",
		connectType: null,
		appSettings: { showSavedForms: false, showIncompleteForms: false },
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
				caseListMenuItem: {
					icon: media("cl-icon"),
					audioLabel: media("cl-audio"),
				},
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
				help_media: { audio: media("help-aud") },
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
			"help-aud",
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

/** A module whose case list menu entry sits beside its form: the entry is
 *  emitted beside forms, so its media is a rendered ref. */
function docWithCaseListEntryBesideForm() {
	const moduleUuid = testUuid("mod-x");
	const formUuid = testUuid("form-x");
	return admittedPersisted({
		appId: "app-2",
		appName: "Beside",
		connectType: null,
		appSettings: { showSavedForms: false, showIncompleteForms: false },
		caseTypes: [{ name: "patient", properties: [] }],
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [TEXT_FIELD] },
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "m",
				name: "M",
				caseType: "patient",
				caseListMenuItem: {
					icon: media("beside-cl-icon"),
					audioLabel: media("beside-cl-audio"),
				},
				caseListConfig: {
					columns: [plainColumn(COLUMN, "case_name", "Name")],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
				},
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "f",
				name: "F",
				type: "followup",
				caseOperations: [
					{ uuid: testUuid("form-x-own"), id: "patient", action: "own" },
				],
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
		appSettings: { showSavedForms: false, showIncompleteForms: false },
		caseTypes: [{ name: "patient", properties: [] }],
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [] },
		fieldOrder: {},
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "m",
				name: "M",
				caseListMenuItem: {},
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
	it("walks a case list menu entry's media beside forms, where the entry is emitted", () => {
		const doc = asWalkableDoc(docWithCaseListEntryBesideForm());
		const gated = collectAssetRefs(doc);
		expect(gated.has(media("beside-cl-icon"))).toBe(true);
		expect(gated.has(media("beside-cl-audio"))).toBe(true);
		const remapped = remapAssetRefs(
			docWithCaseListEntryBesideForm(),
			new Map([[media("beside-cl-icon"), media("beside-cl-icon-2")]]),
		);
		expect(remapped.modules[testUuid("mod-x")]?.caseListMenuItem?.icon).toBe(
			media("beside-cl-icon-2"),
		);
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

/** `Patients` always offers `Registration`'s form, its Register button
 *  carrying an icon and a spoken label. */
function docWithRegisterButtonMedia() {
	const host = testUuid("mod-host");
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "mod-host",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "host-visit",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "mod-registration",
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "register",
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[host].caseListRegistrationForm = {
		kind: "always",
		formUuid: testUuid("register"),
		icon: media("register-icon"),
		audioLabel: media("register-audio"),
		afterSubmit: "case-list",
	};
	return toPersistableDoc(expectAdmittedDoc(doc));
}

describe("the Register button's media", () => {
	it("is walked for export, named by its carrier, and moved with the app", () => {
		const persisted = docWithRegisterButtonMedia();
		const doc = asWalkableDoc(persisted);
		const refs = [...walkAssetRefs(doc)].filter(
			(ref) =>
				ref.location.kind === "case_list_registration_icon" ||
				ref.location.kind === "case_list_registration_audio_label",
		);
		expect(refs.map((ref) => [ref.assetId, ref.slotKind])).toEqual([
			[media("register-icon"), "image"],
			[media("register-audio"), "audio"],
		]);
		expect(refs.map(describeCarrier)).toEqual([
			"the Register button on Patients's case list",
			"the Register button on Patients's case list",
		]);
		expect(collectAuthoredAssetRefs(doc).has(media("register-audio"))).toBe(
			true,
		);
		const remapped = remapAssetRefs(
			persisted,
			new Map([
				[media("register-icon"), media("register-icon-2")],
				[media("register-audio"), media("register-audio-2")],
			]),
		);
		expect(
			remapped.modules[testUuid("mod-host")]?.caseListRegistrationForm,
		).toMatchObject({
			icon: media("register-icon-2"),
			audioLabel: media("register-audio-2"),
		});
	});
});
