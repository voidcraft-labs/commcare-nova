/**
 * Behavioral tests for `attach_option_media`.
 *
 * Coverage:
 *   1. Sets the media on the named option, leaving siblings untouched.
 *   2. Clears the option's media with an empty bundle.
 *   3. Refuses a non-select field.
 *   4. Refuses an unknown option value, naming the values that exist.
 *   5. Cross-surface parity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachOptionMediaTool } from "../attachOptionMedia";
import {
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	SELECT_FIELD,
} from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
	loadAppProjectId: vi.fn(() => Promise.resolve("project-1")),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
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

describe("attachOptionMedia", () => {
	it("sets media on the named option without disturbing siblings", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "symptom",
				optionValue: "fever",
				media: { image: "asset-img-1" },
			},
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

	it("clears the option's media with an empty bundle", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await attachOptionMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "symptom",
				optionValue: "fever",
				media: { image: "asset-img-1" },
			},
			ctx,
			baseDoc,
		);
		const cleared = await attachOptionMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "symptom",
				optionValue: "fever",
				media: {},
			},
			ctx,
			seeded.newDoc,
		);
		const options = optionsOf(cleared.newDoc);
		expect(options[0].media).toBeUndefined();
		expect(cleared.result).toContain("Cleared");
	});

	it("refuses a non-select field", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				optionValue: "fever",
				media: { image: "asset-img-1" },
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("no options");
	});

	it("refuses an unknown option value and names the existing values", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await attachOptionMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "symptom",
				optionValue: "nope",
				media: { image: "asset-img-1" },
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain('"nope"');
		expect(result.result.error).toContain('"fever"');
		expect(result.result.error).toContain('"cough"');
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const input = {
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "symptom",
			optionValue: "fever",
			media: { audio: "asset-aud-1" },
		};
		const r1 = await attachOptionMediaTool.execute(input, chatCtx, doc);
		const r2 = await attachOptionMediaTool.execute(input, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});
