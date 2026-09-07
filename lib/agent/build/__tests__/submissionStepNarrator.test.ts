import { describe, expect, it } from "vitest";
import { createSubmissionStepNarrator } from "../progress";

const LABELS = [
	["charter", "Setting the app direction"],
	["records", "Working out the records"],
	["actors", "Understanding who does what"],
	["workflows", "Shaping the workflows"],
] as const;

// Advisory streaming JSON key recognition only. Provider quality and ordering
// are not assumed; labels follow keys actually observed at the root object.
describe("submission narration", () => {
	it("tracks only complete top-level keys, preserving the last known step", () => {
		const narrator = createSubmissionStepNarrator(LABELS);
		expect(narrator.feed('{"charter":{')).toBe("Setting the app direction");
		expect(
			narrator.feed(
				'"objective":"records","records":[],"other":{"workflows":[]}}',
			),
		).toBe("Setting the app direction");
		expect(narrator.feed(',"unknown":"workflows"')).toBe(
			"Setting the app direction",
		);
		expect(narrator.feed(',"records"')).toBe("Setting the app direction");
		expect(narrator.feed(" : [")).toBe("Working out the records");
		expect(narrator.feed('],"workflows":[],"tail":true}')).toBe(
			"Shaping the workflows",
		);
	});

	it("recognizes keys in actual arrival order across every two-chunk split", () => {
		const text = JSON.stringify({
			charter: { text: 'quote " and slash \\ and } [ :', workflows: [] },
			records: [],
			actors: [],
		});
		for (let split = 0; split <= text.length; split++) {
			const narrator = createSubmissionStepNarrator(LABELS);
			narrator.feed(text.slice(0, split));
			expect(narrator.feed(text.slice(split)), `split ${split}`).toBe(
				"Understanding who does what",
			);
		}
		const single = createSubmissionStepNarrator(LABELS);
		for (const char of text) single.feed(char);
		expect(single.feed("")).toBe("Understanding who does what");
	});

	it("decodes escaped key characters and ignores quoted values and deeply nested keys", () => {
		const narrator = createSubmissionStepNarrator(LABELS);
		expect(
			narrator.feed('{"value":"records","nested":[{"actors":{}}]'),
		).toBeUndefined();
		expect(narrator.feed(',"rec\\u006frds" : []}')).toBe(
			"Working out the records",
		);
	});

	it("recognizes the current patch tool's upserts after nested removals data", () => {
		const narrator = createSubmissionStepNarrator([
			["upserts", "Updating records"],
		]);
		expect(narrator.feed('{"context":{"upserts":[]},"up')).toBeUndefined();
		expect(narrator.feed('serts":[')).toBe("Updating records");
	});

	it("handles no labels and large values without losing the next root key", () => {
		expect(
			createSubmissionStepNarrator([]).feed('{"records":[]}'),
		).toBeUndefined();
		const narrator = createSubmissionStepNarrator(LABELS);
		expect(narrator.feed(`{"unknown":"${"x".repeat(100_000)}`)).toBeUndefined();
		expect(narrator.feed('","records":[]}')).toBe("Working out the records");
	});
});
