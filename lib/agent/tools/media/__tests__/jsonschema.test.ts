/** Offline JSON-schema consumers validate concrete payloads. This proves local
 * conversion semantics, not provider API acceptance or media bytes validity. */
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uploadMediaAssetInputSchema } from "@/lib/mcp/tools/uploadMediaAsset";
import { editFieldInputSchema } from "../../editField";
import { attachFieldMediaInputSchema } from "../attachFieldMedia";
import { attachOptionMediaInputSchema } from "../attachOptionMedia";
import { listMediaAssetsInputSchema } from "../listMediaAssets";
import { removeMediaAssetInputSchema } from "../removeMediaAsset";
import { setAppLogoInputSchema } from "../setAppLogo";
import { setMenuMediaInputSchema } from "../setMenuMedia";
import {
	ASSET_IMG_1,
	FEVER_OPTION,
	FORM_A,
	MOD_A,
	SELECT_FIELD,
	TEXT_FIELD,
} from "./fixtures";

const address = { moduleUuid: MOD_A, formUuid: FORM_A, fieldUuid: TEXT_FIELD };
const cases = [
	[
		"attachFieldMedia",
		attachFieldMediaInputSchema,
		{
			attachments: [
				{ ...address, slot: "label", media: { image: ASSET_IMG_1 } },
			],
		},
	],
	[
		"attachOptionMedia",
		attachOptionMediaInputSchema,
		{
			attachments: [
				{
					...address,
					fieldUuid: SELECT_FIELD,
					optionUuid: FEVER_OPTION,
					media: {},
				},
			],
		},
	],
	[
		"setMenuMedia",
		setMenuMediaInputSchema,
		{
			items: [
				{
					target: "module",
					moduleUuid: MOD_A,
					icon: "household",
					audioLabel: null,
				},
			],
		},
	],
	["setAppLogo", setAppLogoInputSchema, { logo: ASSET_IMG_1 }],
	[
		"listMediaAssets",
		listMediaAssetsInputSchema,
		{ kind: "audio", cursor: "page-2" },
	],
	["removeMediaAsset", removeMediaAssetInputSchema, { assetId: ASSET_IMG_1 }],
	[
		"uploadMediaAsset",
		uploadMediaAssetInputSchema,
		{ filename: "logo.png", mime_type: "image/png", data_base64: "aGVsbG8=" },
	],
	[
		"editField",
		editFieldInputSchema,
		{
			...address,
			updates: {
				kind: "text",
				label: { parts: [{ kind: "text", text: "Patient" }] },
			},
		},
	],
] as const;
describe("media tool JSON schema consumers", () => {
	for (const [name, schema, valid] of cases) {
		it(`${name} admits its payload and rejects an unknown top-level key`, () => {
			expect(schema.safeParse(valid).success).toBe(true);
			const ajv = new Ajv2020({ strict: false });
			addFormats(ajv);
			const validate = ajv.compile(z.toJSONSchema(schema));
			expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
			expect(validate({ ...valid, unexpected: true })).toBe(false);
		});
	}
});
