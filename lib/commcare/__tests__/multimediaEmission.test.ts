/**
 * Media emission through `expandDoc` → `buildXForm` and the HQ shells.
 *
 * Covers the two media-ON surfaces the expander owns:
 *   - XForm itext: `<value form="image|audio|video">` siblings on a
 *     field's label / help / validation entries and on a select option,
 *     plus the `<help>` body ref a `help` slot adds.
 *   - HQ shells: module/form `media_image` dicts, the application
 *     `multimedia_map`, and `logo_refs`.
 *
 * And the media-OFF parity: with no manifest the XForm carries no media
 * references at all (the validation-loop / asset-free-preview path).
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { asAssetId } from "@/lib/domain/multimedia";

// Asset ids referenced by the fixture doc, each mapped to a distinct
// content hash so the emitted jr:// paths are distinguishable.
const HASHES = {
	"label-img": "1".repeat(64),
	"help-aud": "2".repeat(64),
	"vmsg-img": "3".repeat(64),
	"opt-img": "4".repeat(64),
	"mod-icon": "5".repeat(64),
	"form-icon": "6".repeat(64),
	logo: "7".repeat(64),
} as const;

function makeManifest(): AssetManifest {
	const m = new Map<ReturnType<typeof asAssetId>, ResolvedMediaAsset>();
	for (const [id, hash] of Object.entries(HASHES)) {
		const kind = id === "help-aud" ? "audio" : "image";
		const extension = kind === "audio" ? ".mp3" : ".png";
		m.set(asAssetId(id), {
			assetId: asAssetId(id),
			wirePath: `commcare/${hash}${extension}`,
			kind,
			mimeType: kind === "audio" ? "audio/mpeg" : "image/png",
			contentHash: hash,
			extension,
		});
	}
	return m;
}

function ref(id: keyof typeof HASHES): string {
	const ext = id === "help-aud" ? ".mp3" : ".png";
	return `jr://file/commcare/${HASHES[id]}${ext}`;
}

/** A doc with one module/form carrying media on a text field + a select. */
function mediaDoc() {
	return buildDoc({
		appName: "Media app",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Patient name",
								case_property_on: "patient",
								label_media: { image: "label-img" },
								help: "Use the name on their ID.",
								help_media: { audio: "help-aud" },
								validate: ". != ''",
								validate_msg: "Name is required",
								validate_msg_media: { image: "vmsg-img" },
							}),
							f({
								kind: "single_select",
								id: "triage_color",
								label: "Triage color",
								options: [
									{ value: "red", label: "Red", media: { image: "opt-img" } },
									{ value: "green", label: "Green" },
								],
							}),
						],
					},
				],
			},
		],
	});
}

function firstFormXml(hqJson: ReturnType<typeof expandDoc>): string {
	const first = Object.values(hqJson._attachments)[0];
	if (typeof first !== "string")
		throw new Error("expected an XForm attachment");
	return first;
}

describe("XForm itext media emission", () => {
	it("emits <value form=...> media siblings and a <help> ref when assets are provided", () => {
		const xml = firstFormXml(expandDoc(mediaDoc(), { assets: makeManifest() }));

		// Label image, help audio, validation image, and the option image
		// each appear as a jr://file/commcare/<hash> media value.
		expect(xml).toContain(`<value form="image">${ref("label-img")}</value>`);
		expect(xml).toContain(`<value form="audio">${ref("help-aud")}</value>`);
		expect(xml).toContain(`<value form="image">${ref("vmsg-img")}</value>`);
		expect(xml).toContain(`<value form="image">${ref("opt-img")}</value>`);

		// The help slot adds a body <help> ref alongside the label.
		expect(xml).toContain('<help ref="jr:itext(&apos;case_name-help&apos;)"/>');

		// The media-bearing form is still oracle-clean.
		expect(validateXForm(xml, "Register", "Patients")).toEqual([]);
	});

	it("emits jr:constraintMsg + itext for a media-only validate_msg_media (no text)", () => {
		// Regression: the jr:constraintMsg bind attribute must gate on text
		// OR media (mirroring `addItext`'s registration rule). A media-only
		// cue otherwise registers an orphan itext entry that nothing
		// references — the author's validation media silently never displays.
		const doc = buildDoc({
			appName: "Media-only validate_msg",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
									validate: ". != ''",
									// validate_msg deliberately absent — only the media.
									validate_msg_media: { audio: "help-aud" },
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(expandDoc(doc, { assets: makeManifest() }));
		// The bind references the itext entry…
		expect(xml).toContain(
			'jr:constraintMsg="jr:itext(&apos;case_name-constraintMsg&apos;)"',
		);
		// …and the entry carries the media value (empty text values + media).
		expect(xml).toContain(
			`<value form="audio">${ref("help-aud")}</value></text>`,
		);
	});

	it("emits NO media value siblings when no manifest is provided (media off)", () => {
		const xml = firstFormXml(expandDoc(mediaDoc()));
		// No media <value form="..."> siblings at all.
		expect(xml).not.toContain('<value form="image"');
		expect(xml).not.toContain('<value form="audio"');
		expect(xml).not.toContain('<value form="video"');
		// But the help TEXT slot still emits — it's text, not media, so the
		// `<help>` body ref + its itext entry are independent of the manifest.
		expect(xml).toContain('<help ref="jr:itext(&apos;case_name-help&apos;)"/>');
		expect(validateXForm(xml, "Register", "Patients")).toEqual([]);
	});
});

describe("HQ shell media stamping", () => {
	it("stamps module/form media dicts, multimedia_map, and logo_refs", () => {
		const doc = mediaDoc();
		// buildDoc's spec doesn't expose menu-media / logo slots; set them on
		// the normalized doc directly (the schemas carry them from Segment 1).
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		doc.modules[moduleUuid].icon = "mod-icon";
		doc.forms[formUuid].icon = "form-icon";
		doc.logo = "logo";

		const hqJson = expandDoc(doc, { assets: makeManifest() });

		expect(hqJson.modules[0].media_image).toEqual({ en: ref("mod-icon") });
		expect(hqJson.modules[0].forms[0].media_image).toEqual({
			en: ref("form-icon"),
		});
		expect(hqJson.logo_refs).toEqual({
			hq_logo_web_apps: { path: ref("logo") },
		});
		// multimedia_map keys on the wire path (no jr://file/ prefix).
		expect(hqJson.multimedia_map[`commcare/${HASHES["mod-icon"]}.png`]).toEqual(
			{
				multimedia_id: HASHES["mod-icon"],
				media_type: "CommCareImage",
				version: 1,
			},
		);
	});

	it("leaves shells media-free when no manifest is provided", () => {
		const hqJson = expandDoc(mediaDoc());
		expect(hqJson.modules[0].media_image).toEqual({});
		expect(hqJson.multimedia_map).toEqual({});
		expect(hqJson.logo_refs).toEqual({});
	});
});
