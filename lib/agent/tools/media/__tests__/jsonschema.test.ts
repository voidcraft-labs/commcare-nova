/**
 * Guard: every new media tool input schema (plus the grown editField
 * edit-patch schema and the MCP upload schema) lowers to JSON Schema
 * without throwing. This is the local stand-in for `scripts/test-schema.ts`'s
 * compiler smoke test on machines without an ANTHROPIC_API_KEY — a Zod
 * `.transform()` (which the media slots deliberately avoid) is what would
 * make `z.toJSONSchema` throw, so a clean lowering proves the schemas are
 * representable for the Anthropic tool-input compiler.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uploadMediaAssetInputSchema } from "@/lib/mcp/tools/uploadMediaAsset";
import { editFieldInputSchema } from "../../editField";
import { attachFieldMediaInputSchema } from "../attachFieldMedia";
import { attachOptionMediaInputSchema } from "../attachOptionMedia";
import { listMediaAssetsInputSchema } from "../listMediaAssets";
import { removeMediaAssetInputSchema } from "../removeMediaAsset";
import { setAppLogoInputSchema } from "../setAppLogo";
import { setFormMediaInputSchema } from "../setFormMedia";
import { setModuleMediaInputSchema } from "../setModuleMedia";

const schemas = {
	attachFieldMedia: attachFieldMediaInputSchema,
	attachOptionMedia: attachOptionMediaInputSchema,
	setModuleMedia: setModuleMediaInputSchema,
	setFormMedia: setFormMediaInputSchema,
	setAppLogo: setAppLogoInputSchema,
	listMediaAssets: listMediaAssetsInputSchema,
	removeMediaAsset: removeMediaAssetInputSchema,
	uploadMediaAsset: uploadMediaAssetInputSchema,
	editField: editFieldInputSchema,
} as const;

describe("media tool input schemas lower to JSON Schema", () => {
	for (const [name, schema] of Object.entries(schemas)) {
		it(`${name} serializes without throwing`, () => {
			expect(() => z.toJSONSchema(schema as z.ZodType)).not.toThrow();
		});
	}
});
