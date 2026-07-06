/**
 * Behavioral tests for `attach_option_media` (batch-shaped: one call
 * attaches to one or more options, all-or-nothing).
 *
 * Coverage:
 *   1. Sets the media on the named option, leaving siblings untouched.
 *   2. A multi-attachment batch covers a whole field's options in one call.
 *   3. Clears the option's media with an empty bundle.
 *   4. Refuses a non-select field.
 *   5. Refuses an unknown option value, naming the values that exist;
 *      one bad attachment fails the whole batch with nothing written.
 *   6. Cross-surface parity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Media } from "@/lib/domain";
import { attachOptionMediaTool } from "../attachOptionMedia";
import {
	errorOf,
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	SELECT_FIELD,
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

/** Read the options off the select field in a post-mutation doc. */
function optionsOf(doc: { fields: Record<string, unknown> }) {
	const field = doc.fields[SELECT_FIELD] as {
		options: { value: string; media?: unknown }[];
	};
	return field.options;
}

/** One attachment on the fixture's symptom field (m0-f0). */
const attachment = (optionValue: string, media: Partial<Media>) => ({
	moduleIndex: 0,
	formIndex: 0,
	fieldId: "symptom",
	optionValue,
	media,
});

/** Wrap attachments in the batch input shape. */
const input = (...attachments: ReturnType<typeof attachment>[]) => ({
	attachments,
});

describe("attachOptionMedia", () => {
	it("sets media on the named option without disturbing siblings", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			input(attachment("fever", { image: "asset-img-1" })),
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const options = optionsOf(result.newDoc);
		expect(options[0].value).toBe("fever");
		expect(options[0].media).toEqual({ image: "asset-img-1" });
		// Sibling option keeps no media.
		expect(options[1].value).toBe("cough");
		expect(options[1].media).toBeUndefined();
	});

	it("covers a whole field's options in one batch", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			input(
				attachment("fever", { image: "asset-img-1" }),
				attachment("cough", { audio: "asset-aud-1" }),
			),
			ctx,
			doc,
		);
		const options = optionsOf(result.newDoc);
		expect(options[0].media).toEqual({ image: "asset-img-1" });
		expect(options[1].media).toEqual({ audio: "asset-aud-1" });
		const success = result.result as { summary?: { count?: number } };
		expect(success.summary).toEqual({ count: 2 });
	});

	it("clears the option's media with an empty bundle", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await attachOptionMediaTool.execute(
			input(attachment("fever", { image: "asset-img-1" })),
			ctx,
			baseDoc,
		);
		const cleared = await attachOptionMediaTool.execute(
			input(attachment("fever", {})),
			ctx,
			seeded.newDoc,
		);
		const options = optionsOf(cleared.newDoc);
		expect(options[0].media).toBeUndefined();
		const success = cleared.result as { message?: string };
		expect(success.message).toContain("Cleared");
	});

	it("refuses a non-select field", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			{
				attachments: [
					{
						moduleIndex: 0,
						formIndex: 0,
						fieldId: "patient_name",
						optionValue: "fever",
						media: { image: "asset-img-1" },
					},
				],
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(errorOf(result)).toContain("no options");
	});

	it("refuses an unknown option value and names the existing values", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			input(attachment("nope", { image: "asset-img-1" })),
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain('"nope"');
		expect(error).toContain('"fever"');
		expect(error).toContain('"cough"');
	});

	it("writes nothing when one attachment of a batch doesn't resolve", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			input(
				attachment("fever", { image: "asset-img-1" }),
				attachment("nope", { image: "asset-img-1" }),
			),
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(optionsOf(result.newDoc)[0].media).toBeUndefined();
		const error = errorOf(result);
		expect(error).toContain("attachments[1]");
		expect(error).toContain("nothing was attached");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const batch = input(attachment("fever", { audio: "asset-aud-1" }));
		const r1 = await attachOptionMediaTool.execute(batch, chatCtx, doc);
		const r2 = await attachOptionMediaTool.execute(batch, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});
