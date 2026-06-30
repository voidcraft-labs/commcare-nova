/**
 * `remapAssetRefs` is the write counterpart of `walkAssetRefs` — it must touch
 * every media slot the walk reads, or a moved app would keep a stale ref the
 * walk still surfaces. The headline test is COVERAGE PARITY: remap every id
 * through a full map, then assert `collectAssetRefs` of the result is exactly the
 * mapped set. A slot added to the walk but not to the remap fails it.
 */

import { describe, expect, it } from "vitest";
import { blueprintDocSchema } from "../blueprint";
import { asWalkableDoc, collectAssetRefs, remapAssetRefs } from "../mediaRefs";
import { NOVA_ICON_REF_PREFIX } from "../multimedia";

const BUILTIN_REF = `${NOVA_ICON_REF_PREFIX}health`;

/** A blueprint with a distinct asset id in EVERY slot `walkAssetRefs` covers:
 *  app logo; a caseListOnly module's icon/audioLabel + caseListConfig
 *  icon/audioLabel + an image-map column's mapping; a regular module's
 *  icon/audioLabel; a form's icon/audioLabel; all four field media bundles ×
 *  image/audio/video; and select-option media. Plus a built-in icon ref to
 *  prove pass-through. */
function fixtureDoc() {
	return blueprintDocSchema.parse({
		appId: "app-1",
		appName: "Fixture",
		connectType: null,
		caseTypes: null,
		logo: "logo",
		moduleOrder: ["mod-a", "mod-b"],
		formOrder: { "mod-a": [], "mod-b": ["form-1"] },
		fieldOrder: { "form-1": ["field-text", "field-select"] },
		modules: {
			"mod-a": {
				uuid: "mod-a",
				id: "case_list",
				name: "Case list",
				caseListOnly: true,
				icon: "mod-a-icon",
				audioLabel: "mod-a-audio",
				caseListConfig: {
					columns: [
						{
							uuid: "col-1",
							kind: "image-map",
							field: "status",
							header: "Status",
							mapping: [
								{ value: "v1", assetId: "imgmap-1" },
								{ value: "v2", assetId: "imgmap-2" },
							],
						},
					],
					searchInputs: [],
					icon: "cl-icon",
					audioLabel: "cl-audio",
				},
			},
			"mod-b": {
				uuid: "mod-b",
				id: "intake_module",
				name: "Intake",
				icon: BUILTIN_REF,
				audioLabel: "mod-b-audio",
			},
		},
		forms: {
			"form-1": {
				uuid: "form-1",
				id: "intake",
				name: "Intake",
				type: "registration",
				icon: "form-icon",
				audioLabel: "form-audio",
			},
		},
		fields: {
			"field-text": {
				kind: "text",
				uuid: "field-text",
				id: "patient_name",
				label: "Name",
				label_media: { image: "lbl-img", audio: "lbl-aud", video: "lbl-vid" },
				hint_media: { image: "hint-img" },
				help_media: { audio: "help-aud" },
				validate_msg_media: { video: "val-vid" },
			},
			"field-select": {
				kind: "single_select",
				uuid: "field-select",
				id: "symptom",
				label: "Symptom",
				options: [
					{
						value: "fever",
						label: "Fever",
						media: { image: "opt-img", audio: "opt-aud" },
					},
					{ value: "cough", label: "Cough" },
				],
			},
		},
	});
}

describe("remapAssetRefs", () => {
	it("covers every slot walkAssetRefs reads (coverage parity)", () => {
		const doc = fixtureDoc();
		const ids = collectAssetRefs(asWalkableDoc(doc));
		// Sanity: the fixture really does exercise a broad slot set.
		expect(ids.size).toBeGreaterThanOrEqual(17);

		const fullMap = new Map([...ids].map((id) => [id, `${id}__M`]));
		const remapped = remapAssetRefs(doc, fullMap);

		const remappedIds = collectAssetRefs(asWalkableDoc(remapped));
		expect(remappedIds).toEqual(new Set([...ids].map((id) => `${id}__M`)));
	});

	it("leaves the input doc untouched", () => {
		const doc = fixtureDoc();
		const before = collectAssetRefs(asWalkableDoc(doc));
		remapAssetRefs(doc, new Map([["logo", "logo__M"]]));
		expect(collectAssetRefs(asWalkableDoc(doc))).toEqual(before);
	});

	it("passes through ids absent from the map (built-in refs, partial maps)", () => {
		const doc = fixtureDoc();
		// Map only the logo; everything else — including the built-in icon ref —
		// must survive unchanged.
		const remapped = remapAssetRefs(doc, new Map([["logo", "logo__M"]]));
		const ids = collectAssetRefs(asWalkableDoc(remapped));
		expect(ids.has("logo__M")).toBe(true);
		expect(ids.has("logo")).toBe(false);
		expect(ids.has(BUILTIN_REF)).toBe(true); // built-in untouched
		expect(ids.has("opt-img")).toBe(true); // unmapped real id untouched
	});

	it("returns the same doc reference when the map is empty", () => {
		const doc = fixtureDoc();
		expect(remapAssetRefs(doc, new Map())).toBe(doc);
	});
});
