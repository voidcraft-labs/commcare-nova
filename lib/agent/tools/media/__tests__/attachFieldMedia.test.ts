/**
 * Behavioral tests for `attach_field_media`.
 *
 * Coverage:
 *   1. Sets a slot's media bundle on the field.
 *   2. Clears the slot when handed an empty bundle.
 *   3. CLEAR survives the SSE JSON wire (the blocker regression guard) —
 *      a clear encoded as `{ key: undefined }` would be dropped by
 *      `JSON.stringify` and silently no-op on the client.
 *   4. Refuses a slot the field's kind doesn't carry (validate_msg on a
 *      hidden field) with an Elm-style error naming the available slots.
 *   5. Field-not-found surfaces an Elm-style error.
 *   6. Cross-surface parity — chat + MCP contexts produce identical
 *      mutation batches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import { attachFieldMediaTool } from "../attachFieldMedia";
import {
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	seedTestAsset,
	TEXT_FIELD,
} from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
	loadAppProjectId: vi.fn(() => Promise.resolve("project-1")),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));
// Firestore-constructing module stubbed at the import boundary; the
// attach verdict's asset reads resolve against the fixtures' in-memory
// table instead.
vi.mock("@/lib/db/mediaAssets", async () => ({
	loadAssetsByIds: (await import("./fixtures")).loadAssetsByIdsMock,
}));

beforeEach(() => {
	vi.clearAllMocks();
	resetTestAssets();
});

describe("attachFieldMedia", () => {
	it("sets the image on a field's label slot", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-img-1" },
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const field = result.newDoc.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toEqual({ image: "asset-img-1" });
	});

	it("sets a multi-slot bundle on the hint slot", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "hint",
				media: { image: "asset-img-1", audio: "asset-aud-1" },
			},
			ctx,
			doc,
		);
		const field = result.newDoc.fields[TEXT_FIELD];
		expect(
			field && "hint_media" in field ? field.hint_media : undefined,
		).toEqual({ image: "asset-img-1", audio: "asset-aud-1" });
	});

	it("clears the slot when handed an empty bundle", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		// Seed an existing label_media so the clear has something to remove.
		const seeded = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-img-1" },
			},
			ctx,
			baseDoc,
		);

		const cleared = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: {},
			},
			ctx,
			seeded.newDoc,
		);
		const field = cleared.newDoc.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
		expect(cleared.result).toContain("Cleared");
	});

	it("clears the slot AFTER a JSON wire round-trip (blocker guard)", async () => {
		// Build a doc that already has label_media set, then take the CLEAR
		// tool's mutations and apply them through `applyOverWire` (JSON
		// serialize/parse) against that doc — exactly what the client does
		// with the SSE `data-mutations` payload. A clear encoded as
		// `{ label_media: undefined }` on an `updateField` patch would be
		// dropped by `JSON.stringify` and the slot would survive; the
		// dedicated `setFieldMedia` mutation carries an explicit `null`, so
		// it clears over the wire too.
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-img-1" },
			},
			ctx,
			baseDoc,
		);
		const clear = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: {},
			},
			ctx,
			seeded.newDoc,
		);

		const overWire = applyOverWire(seeded.newDoc, clear.mutations);
		const field = overWire.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
	});

	it("refuses a slot the field's kind doesn't carry", async () => {
		const { doc, ctx } = makeMediaFixture();
		// A hidden field carries no validate_msg media slot.
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "computed_score",
				slot: "validate_msg",
				media: { image: "asset-img-1" },
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("hidden field");
		expect(result.result.error).toContain("validate_msg");
	});

	it("returns an Elm-style error when the field id is unknown", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "nope",
				slot: "label",
				media: { image: "asset-img-1" },
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to attach label media");
		expect(result.result.error).toContain('"nope"');
	});

	it("refuses an asset id that isn't in the caller's library", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-nope" },
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("asset-nope");
		expect(result.result.error).toContain("library");
		// Nothing committed.
		const field = result.newDoc.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
	});

	it("refuses a foreign-Project asset with the same message as a missing one", async () => {
		seedTestAsset("asset-foreign", "image", { project_id: "project-2" });
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-foreign" },
			},
			ctx,
			doc,
		);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("library");
		expect(result.result.error).not.toContain("project-2");
	});

	it("refuses an asset whose upload hasn't confirmed", async () => {
		seedTestAsset("asset-pending", "image", { status: "pending" });
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "hint",
				media: { image: "asset-pending" },
			},
			ctx,
			doc,
		);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("upload hasn't finished");
		expect(result.mutations).toEqual([]);
	});

	it("refuses an asset whose kind doesn't match the slot it's placed in", async () => {
		const { doc, ctx } = makeMediaFixture();
		// An audio asset placed in the bundle's IMAGE slot.
		const result = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-aud-1" },
			},
			ctx,
			doc,
		);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("an audio file");
		expect(result.result.error).toContain("an image");
		expect(result.mutations).toEqual([]);
	});

	it("clears without touching the asset table (no verdict on a clear)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: { image: "asset-img-1" },
			},
			ctx,
			baseDoc,
		);
		// Even with EVERY row gone, the clear commits — a clear carries no
		// expectations, so the asset table is never consulted.
		resetTestAssets();
		seedTestAsset("asset-img-1", "image", { project_id: "project-2" });
		const cleared = await attachFieldMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				slot: "label",
				media: {},
			},
			ctx,
			seeded.newDoc,
		);
		expect(cleared.result).toContain("Cleared");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const input = {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "patient_name",
			slot: "label" as const,
			media: { image: "asset-img-1" },
		};
		const r1 = await attachFieldMediaTool.execute(input, chatCtx, doc);
		const r2 = await attachFieldMediaTool.execute(input, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});
