/**
 * Behavioral tests for `attach_field_media` (batch-shaped: one call
 * attaches to one or more field message slots, all-or-nothing).
 *
 * Coverage:
 *   1. Sets a slot's media bundle on the field.
 *   2. A multi-attachment batch lands on several fields in one call.
 *   3. Clears the slot when handed an empty bundle.
 *   4. CLEAR survives the SSE JSON wire (the blocker regression guard) —
 *      a clear encoded as `{ key: undefined }` would be dropped by
 *      `JSON.stringify` and silently no-op on the client.
 *   5. Refuses a slot the field's kind doesn't carry (validate_msg on a
 *      hidden field) with an Elm-style error naming the available slots.
 *   6. Field-not-found surfaces an Elm-style error; one bad attachment
 *      fails the whole batch with nothing written.
 *   7. Cross-surface parity — chat + MCP contexts produce identical
 *      mutation batches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import type { Media } from "@/lib/domain";
import { attachFieldMediaTool } from "../attachFieldMedia";
import type { FieldMediaSlot } from "../shared";
import {
	errorOf,
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	SELECT_FIELD,
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
// The db-constructing module stubbed at the import boundary; the
// attach verdict's asset reads resolve against the fixtures' in-memory
// table instead.
vi.mock("@/lib/db/mediaAssets", async () => ({
	loadAssetsByIds: (await import("./fixtures")).loadAssetsByIdsMock,
}));

beforeEach(() => {
	vi.clearAllMocks();
	resetTestAssets();
});

/** One attachment on the fixture's m0-f0. */
const attachment = (
	fieldId: string,
	slot: FieldMediaSlot,
	media: Partial<Media>,
) => ({ moduleIndex: 0, formIndex: 0, fieldId, slot, media });

/** Wrap attachments in the batch input shape. */
const input = (...attachments: ReturnType<typeof attachment>[]) => ({
	attachments,
});

/** Narrow a result to its success message, failing the test on error. */
function messageOf(result: { result: unknown }): string {
	const r = result.result as { message?: string; error?: string };
	if (r.message === undefined) throw new Error(r.error ?? "expected success");
	return r.message;
}

describe("attachFieldMedia", () => {
	it("sets the image on a field's label slot", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", { image: "asset-img-1" })),
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
			input(
				attachment("patient_name", "hint", {
					image: "asset-img-1",
					audio: "asset-aud-1",
				}),
			),
			ctx,
			doc,
		);
		const field = result.newDoc.fields[TEXT_FIELD];
		expect(
			field && "hint_media" in field ? field.hint_media : undefined,
		).toEqual({ image: "asset-img-1", audio: "asset-aud-1" });
	});

	it("attaches to several fields in one batch", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(
				attachment("patient_name", "label", { image: "asset-img-1" }),
				attachment("symptom", "label", { audio: "asset-aud-1" }),
			),
			ctx,
			doc,
		);
		const text = result.newDoc.fields[TEXT_FIELD];
		const select = result.newDoc.fields[SELECT_FIELD];
		expect(
			text && "label_media" in text ? text.label_media : undefined,
		).toEqual({ image: "asset-img-1" });
		expect(
			select && "label_media" in select ? select.label_media : undefined,
		).toEqual({ audio: "asset-aud-1" });
		const success = result.result as { summary?: { count?: number } };
		expect(success.summary).toEqual({ count: 2 });
	});

	it("clears the slot when handed an empty bundle", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		// Seed an existing label_media so the clear has something to remove.
		const seeded = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", { image: "asset-img-1" })),
			ctx,
			baseDoc,
		);

		const cleared = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", {})),
			ctx,
			seeded.newDoc,
		);
		const field = cleared.newDoc.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
		expect(messageOf(cleared)).toContain("Cleared");
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
			input(attachment("patient_name", "label", { image: "asset-img-1" })),
			ctx,
			baseDoc,
		);
		const clear = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", {})),
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
			input(
				attachment("computed_score", "validate_msg", { image: "asset-img-1" }),
			),
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("hidden field");
		expect(error).toContain("validate_msg");
	});

	it("returns an Elm-style error when the field id is unknown", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(attachment("nope", "label", { image: "asset-img-1" })),
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("nothing was attached");
		expect(error).toContain('"nope"');
	});

	it("writes nothing when one attachment of a batch doesn't resolve", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(
				attachment("patient_name", "label", { image: "asset-img-1" }),
				attachment("nope", "label", { image: "asset-img-1" }),
			),
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const field = result.newDoc.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
		const error = errorOf(result);
		expect(error).toContain("attachments[1]");
		expect(error).toContain('"nope"');
	});

	it("refuses an asset id that isn't in the caller's library", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", { image: "asset-nope" })),
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("asset-nope");
		expect(error).toContain("library");
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
			input(attachment("patient_name", "label", { image: "asset-foreign" })),
			ctx,
			doc,
		);
		const error = errorOf(result);
		expect(error).toContain("library");
		expect(error).not.toContain("project-2");
	});

	it("refuses an asset whose upload hasn't confirmed", async () => {
		seedTestAsset("asset-pending", "image", { status: "pending" });
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "hint", { image: "asset-pending" })),
			ctx,
			doc,
		);
		expect(errorOf(result)).toContain("upload hasn't finished");
		expect(result.mutations).toEqual([]);
	});

	it("refuses an asset whose kind doesn't match the slot it's placed in", async () => {
		const { doc, ctx } = makeMediaFixture();
		// An audio asset placed in the bundle's IMAGE slot.
		const result = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", { image: "asset-aud-1" })),
			ctx,
			doc,
		);
		const error = errorOf(result);
		expect(error).toContain("an audio file");
		expect(error).toContain("an image");
		expect(result.mutations).toEqual([]);
	});

	it("a verdict failure on one attachment writes nothing for the whole batch", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachFieldMediaTool.execute(
			input(
				attachment("patient_name", "label", { image: "asset-img-1" }),
				attachment("symptom", "label", { image: "asset-nope" }),
			),
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const field = result.newDoc.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
	});

	it("clears without touching the asset table (no verdict on a clear)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", { image: "asset-img-1" })),
			ctx,
			baseDoc,
		);
		// Even with EVERY row gone, the clear commits — a clear carries no
		// expectations, so the asset table is never consulted.
		resetTestAssets();
		seedTestAsset("asset-img-1", "image", { project_id: "project-2" });
		const cleared = await attachFieldMediaTool.execute(
			input(attachment("patient_name", "label", {})),
			ctx,
			seeded.newDoc,
		);
		expect(messageOf(cleared)).toContain("Cleared");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const batch = input(
			attachment("patient_name", "label", { image: "asset-img-1" }),
		);
		const r1 = await attachFieldMediaTool.execute(batch, chatCtx, doc);
		const r2 = await attachFieldMediaTool.execute(batch, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});
