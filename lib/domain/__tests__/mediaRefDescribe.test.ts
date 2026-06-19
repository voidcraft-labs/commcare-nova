// lib/domain/__tests__/mediaRefDescribe.test.ts
//
// Coverage for the media-ref helpers the upload-outcome + app-settings
// surfaces read: `describeCarrier` (carrier → person-readable phrase),
// `carriesViaBulkUpload` (does this carrier ride HQ's bulk upload?), and
// `uncarriedLogoAsset` (the standalone-logo predicate).

import { describe, expect, it } from "vitest";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import {
	type AssetRef,
	carriesViaBulkUpload,
	describeCarrier,
	type MediaRefLocation,
	type MediaSlotKind,
	uncarriedLogoAsset,
} from "../mediaRefs";

function ref(
	location: MediaRefLocation,
	slotKind: MediaSlotKind = "image",
): AssetRef {
	return { assetId: "x", slotKind, location };
}

const U = asUuid("u");

describe("describeCarrier", () => {
	it("names the app logo", () => {
		expect(describeCarrier(ref({ kind: "app_logo" }))).toBe("the app logo");
	});

	it("names module + form menu carriers", () => {
		expect(
			describeCarrier(
				ref({ kind: "module_icon", moduleUuid: U, moduleName: "Patients" }),
			),
		).toBe('the icon on module "Patients"');
		expect(
			describeCarrier(
				ref(
					{
						kind: "form_audio_label",
						moduleUuid: U,
						moduleName: "Patients",
						formUuid: U,
						formName: "Intake",
					},
					"audio",
				),
			),
		).toBe('the audio label on form "Intake" (module "Patients")');
	});

	it("combines media kind + message-slot key for a field bundle", () => {
		expect(
			describeCarrier(
				ref({
					kind: "field_media_bundle",
					bundleKey: "validate_msg_media",
					moduleUuid: U,
					moduleName: "Patients",
					formUuid: U,
					formName: "Intake",
					fieldUuid: U,
					fieldId: "age",
				}),
			),
		).toBe('the image on field "age"\'s validation message (form "Intake")');
	});

	it("names an option and an image-map row", () => {
		expect(
			describeCarrier(
				ref(
					{
						kind: "option_media",
						moduleUuid: U,
						moduleName: "Patients",
						formUuid: U,
						formName: "Intake",
						fieldUuid: U,
						fieldId: "symptom",
						optionValue: "fever",
					},
					"audio",
				),
			),
		).toBe('the audio on option "fever" of field "symptom" (form "Intake")');
		expect(
			describeCarrier(
				ref({
					kind: "image_map_mapping",
					moduleUuid: U,
					moduleName: "Patients",
					columnUuid: U,
					columnHeader: "Status",
					rowIndex: 0,
					rowValue: "active",
				}),
			),
		).toBe('the image-map row "active" in column "Status" (module "Patients")');
	});
});

describe("carriesViaBulkUpload", () => {
	it("is false only for the app logo (the one app-level carrier)", () => {
		expect(carriesViaBulkUpload({ kind: "app_logo" })).toBe(false);
		expect(
			carriesViaBulkUpload({
				kind: "module_icon",
				moduleUuid: U,
				moduleName: "M",
			}),
		).toBe(true);
		expect(
			carriesViaBulkUpload({
				kind: "field_media_bundle",
				bundleKey: "label_media",
				moduleUuid: U,
				moduleName: "M",
				formUuid: U,
				formName: "F",
				fieldUuid: U,
				fieldId: "q",
			}),
		).toBe(true);
	});
});

/** A doc whose only media is the app logo, plus an optional second carrier. */
function docWithLogo(extra?: { moduleIconAsset?: string }): BlueprintDoc {
	return {
		appId: "a",
		appName: "A",
		connectType: null,
		caseTypes: null,
		logo: "logo-asset",
		moduleOrder: ["m1"],
		modules: {
			m1: {
				uuid: "m1",
				id: "reg",
				name: "Registration",
				...(extra?.moduleIconAsset && { icon: extra.moduleIconAsset }),
			},
		},
		formOrder: { m1: [] },
		forms: {},
		fieldOrder: {},
		fields: {},
		fieldParent: {},
	} as unknown as BlueprintDoc;
}

describe("uncarriedLogoAsset", () => {
	it("returns the logo asset id when it's used ONLY as the logo", () => {
		expect(uncarriedLogoAsset(docWithLogo())).toBe("logo-asset");
	});

	it("returns undefined when the logo image is reused by a carrier that carries", () => {
		// Same image is also the module icon → the bulk upload matches it there,
		// so the logo resolves and there's nothing to warn about.
		expect(
			uncarriedLogoAsset(docWithLogo({ moduleIconAsset: "logo-asset" })),
		).toBeUndefined();
	});

	it("returns undefined when there's no logo", () => {
		const noLogo = { ...docWithLogo(), logo: undefined } as BlueprintDoc;
		expect(uncarriedLogoAsset(noLogo)).toBeUndefined();
	});
});
