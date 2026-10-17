// lib/domain/__tests__/mediaRefDescribe.test.ts
//
// Coverage for the media-ref helpers the upload outcome and the bulk ZIP
// read: `describeCarrier` (carrier → person-readable phrase) and
// `carriesViaBulkUpload` (does this carrier ride HQ's bulk upload?).

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import {
	type AssetRef,
	carriesViaBulkUpload,
	describeCarrier,
	type MediaRefLocation,
	type MediaSlotKind,
} from "../mediaRefs";

function ref(
	location: MediaRefLocation,
	slotKind: MediaSlotKind = "image",
): AssetRef {
	return { assetId: testMediaAssetId("x"), slotKind, location };
}

const U = testUuid("u");

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
					bundleKey: "help_media",
					moduleUuid: U,
					moduleName: "Patients",
					formUuid: U,
					formName: "Intake",
					fieldUuid: U,
					fieldId: "age",
				}),
			),
		).toBe('the image on field "age"\'s help (form "Intake")');
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
						optionUuid: U,
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
	it("classifies the logo separately from menu and field examples", () => {
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
