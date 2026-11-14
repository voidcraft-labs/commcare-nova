import { describe, expect, it } from "vitest";
import { parsePreviewTargetFactsFrame } from "../previewTargetFactsFrame";

describe("parsePreviewTargetFactsFrame", () => {
	it("parses a frame holding both facts", () => {
		expect(
			parsePreviewTargetFactsFrame(
				JSON.stringify({
					facts: { fuzzyListSearch: true, markRequiredQuestions: false },
				}),
			),
		).toEqual({
			facts: { fuzzyListSearch: true, markRequiredQuestions: false },
		});
	});

	it("parses a frame that holds no facts", () => {
		expect(
			parsePreviewTargetFactsFrame(JSON.stringify({ facts: null })),
		).toEqual({ facts: null });
	});

	it("gives null for a malformed frame", () => {
		expect(parsePreviewTargetFactsFrame("not json")).toBeNull();
		expect(parsePreviewTargetFactsFrame(JSON.stringify(null))).toBeNull();
		expect(parsePreviewTargetFactsFrame(JSON.stringify({}))).toBeNull();
		expect(
			parsePreviewTargetFactsFrame(
				JSON.stringify({
					facts: { fuzzyListSearch: "yes", markRequiredQuestions: false },
				}),
			),
		).toBeNull();
		expect(
			parsePreviewTargetFactsFrame(
				JSON.stringify({
					facts: {
						fuzzyListSearch: true,
						markRequiredQuestions: false,
						extra: true,
					},
				}),
			),
		).toBeNull();
	});

	it("gives null for a frame missing either fact", () => {
		expect(
			parsePreviewTargetFactsFrame(
				JSON.stringify({ facts: { fuzzyListSearch: true } }),
			),
		).toBeNull();
		expect(
			parsePreviewTargetFactsFrame(
				JSON.stringify({ facts: { markRequiredQuestions: true } }),
			),
		).toBeNull();
	});
});
