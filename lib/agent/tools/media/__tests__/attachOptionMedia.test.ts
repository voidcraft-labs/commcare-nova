/** Actual media command, preflight and canonical reducer behavior over admitted
 * documents and controlled asset rows. JSON clear tests exercise serialization;
 * native persistence and SA/MCP transport are separate proofs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import type { BlueprintDoc, Media, Uuid } from "@/lib/domain";
import { attachOptionMediaTool } from "../attachOptionMedia";
import {
	ASSET_AUD_1,
	ASSET_IMG_1,
	COUGH_OPTION,
	errorOf,
	FEVER_OPTION,
	FORM_A,
	MOD_A,
	makeMediaFixture,
	resetTestAssets,
	SELECT_FIELD,
	TEXT_FIELD,
} from "./fixtures";

const UNKNOWN_OPTION = testUuid("99999999-9999-4999-8999-999999999999");

vi.mock("@/lib/db/apps", () => ({
	loadAppProjectId: vi.fn(() =>
		Promise.resolve({ kind: "found", projectId: "project-1" }),
	),
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

/** Read the options off the select field in a post-mutation doc. */
function optionsOf(doc: BlueprintDoc) {
	const field = doc.fields[SELECT_FIELD];
	if (field?.kind !== "single_select" || field.optionsSource.kind !== "inline")
		throw new Error("expected inline options");
	return field.optionsSource.options;
}

/** One attachment on the fixture's symptom field (m0-f0). */
const attachment = (optionUuid: Uuid, media: Partial<Media>) => ({
	moduleUuid: MOD_A,
	formUuid: FORM_A,
	fieldUuid: SELECT_FIELD,
	optionUuid,
	media,
});

/** Wrap attachments in the batch input shape. */
const input = (...attachments: ReturnType<typeof attachment>[]) => ({
	attachments,
});

describe("attachOptionMedia", () => {
	it("sets media on the named option without disturbing siblings", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachOptionMediaTool,
			input(attachment(FEVER_OPTION, { image: ASSET_IMG_1 })),
		);

		expect(result.kind).toBe("mutate");
		const options = optionsOf(h.currentDoc());
		expect(options[0].value).toBe("fever");
		expect(options[0].media).toEqual({ image: ASSET_IMG_1 });
		// Sibling option keeps no media.
		expect(options[1].value).toBe("cough");
		expect(options[1].media).toBeUndefined();
	});

	it("covers a whole field's options in one batch", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachOptionMediaTool,
			input(
				attachment(FEVER_OPTION, { image: ASSET_IMG_1 }),
				attachment(COUGH_OPTION, { audio: ASSET_AUD_1 }),
			),
		);
		const options = optionsOf(h.currentDoc());
		expect(options[0].media).toEqual({ image: ASSET_IMG_1 });
		expect(options[1].media).toEqual({ audio: ASSET_AUD_1 });
		const success = result.result as { summary?: { count?: number } };
		expect(success.summary).toEqual({ count: 2 });
	});

	it("clears the option's media with an empty bundle", async () => {
		const h = makeMediaFixture();
		await h.runTool(
			attachOptionMediaTool,
			input(attachment(FEVER_OPTION, { image: ASSET_IMG_1 })),
		);
		const beforeClear = h.currentDoc();
		const cleared = await h.runTool(
			attachOptionMediaTool,
			input(attachment(FEVER_OPTION, {})),
		);
		expect(
			optionsOf(applyOverWire(beforeClear, cleared.mutations))[0].media,
		).toBeUndefined();
		const options = optionsOf(h.currentDoc());
		expect(options[0].media).toBeUndefined();
		const success = cleared.result as { message?: string };
		expect(success.message).toContain("Cleared");
	});

	it("refuses a non-select field", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(attachOptionMediaTool, {
			attachments: [
				{
					moduleUuid: MOD_A,
					formUuid: FORM_A,
					fieldUuid: TEXT_FIELD,
					optionUuid: FEVER_OPTION,
					media: { image: ASSET_IMG_1 },
				},
			],
		});
		expect(result.mutations).toEqual([]);
		expect(errorOf(result)).toContain("no options");
	});

	it("refuses an unknown option value and names the existing values", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachOptionMediaTool,
			input(attachment(UNKNOWN_OPTION, { image: ASSET_IMG_1 })),
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain(UNKNOWN_OPTION);
	});

	it("writes nothing when one attachment of a batch doesn't resolve", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachOptionMediaTool,
			input(
				attachment(FEVER_OPTION, { image: ASSET_IMG_1 }),
				attachment(UNKNOWN_OPTION, { image: ASSET_IMG_1 }),
			),
		);
		expect(result.mutations).toEqual([]);
		expect(optionsOf(h.currentDoc())[0].media).toBeUndefined();
		const error = errorOf(result);
		expect(error).toContain("attachments[1]");
		expect(error).toContain("nothing was attached");
	});
});
