/**
 * Behavioral tests for `attach_field_media`.
 *
 * Coverage:
 *   1. Sets a slot's media bundle on the field.
 *   2. Clears the slot when handed an empty bundle.
 *   3. Refuses a slot the field's kind doesn't carry (validate_msg on a
 *      hidden field) with an Elm-style error naming the available slots.
 *   4. Field-not-found surfaces an Elm-style error.
 *   5. Cross-surface parity — chat + MCP contexts produce identical
 *      mutation batches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachFieldMediaTool } from "../attachFieldMedia";
import { makeMediaFixture, makeMediaMcpFixture, TEXT_FIELD } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
	vi.clearAllMocks();
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
