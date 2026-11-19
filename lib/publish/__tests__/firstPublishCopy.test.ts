/**
 * The one renderer of what a first publish changes. Pure. The plausible
 * failures: a line with no words, a list ordered by accident, a
 * worker-touching publish told workers see the same questions, one sentence
 * shown twice, and a next publish headed as a first one.
 */
import { describe, expect, it } from "vitest";
import {
	FIRST_PUBLISH_CHANGE_IDS,
	FIRST_PUBLISH_SAID_BY,
	FIRST_PUBLISH_TOUCHES_WORKERS,
	type FirstPublishChangeId,
	type FirstPublishView,
	firstPublishSentenceId,
} from "../firstPublishChangeIds";
import {
	FIRST_PUBLISH_FORM_BUILDER_NOTE,
	FIRST_PUBLISH_HEADING,
	FIRST_PUBLISH_HQ_LABEL,
	FIRST_PUBLISH_LEAD_PUBLISH,
	FIRST_PUBLISH_LEAD_REVIEW,
	FIRST_PUBLISH_NO_WORKER_CHANGE,
	FIRST_PUBLISH_SENTENCES,
	FIRST_PUBLISH_WORKERS_LABEL,
	firstPublishLines,
} from "../firstPublishCopy";
import {
	NEXT_PUBLISH_DIALOG_LEAD,
	NEXT_PUBLISH_HEADING,
} from "../hqChangesCopy";

function view(
	ids: readonly FirstPublishChangeId[],
	of: FirstPublishView["of"] = "first-publish",
): FirstPublishView {
	return {
		ids,
		touchesWorkers: ids.some((id) => FIRST_PUBLISH_TOUCHES_WORKERS[id]),
		of,
	};
}

const SAID_BY_ANOTHER = new Set<string>(Object.keys(FIRST_PUBLISH_SAID_BY));
const SENTENCE_IDS = FIRST_PUBLISH_CHANGE_IDS.filter(
	(id) => !SAID_BY_ANOTHER.has(id),
);

describe("FIRST_PUBLISH_SENTENCES", () => {
	it("holds exactly one sentence for each id that has a line of its own", () => {
		expect(SENTENCE_IDS).toHaveLength(35);
		expect(Object.keys(FIRST_PUBLISH_SENTENCES).sort()).toEqual(
			[...SENTENCE_IDS].sort(),
		);
	});

	it("words every sentence and constant in Nova's voice", () => {
		const strings = [
			...Object.values(FIRST_PUBLISH_SENTENCES),
			FIRST_PUBLISH_LEAD_REVIEW,
			FIRST_PUBLISH_LEAD_PUBLISH,
			FIRST_PUBLISH_NO_WORKER_CHANGE,
			FIRST_PUBLISH_FORM_BUILDER_NOTE,
		];
		for (const sentence of strings) {
			expect(sentence.trim()).toBe(sentence);
			expect(sentence.length).toBeGreaterThan(0);
			expect(sentence.endsWith(".")).toBe(true);
			expect(sentence).not.toContain("—");
			expect(sentence).not.toContain("…");
			expect(sentence).not.toContain("...");
		}
		for (const label of [
			FIRST_PUBLISH_HEADING,
			FIRST_PUBLISH_WORKERS_LABEL,
			FIRST_PUBLISH_HQ_LABEL,
		]) {
			expect(label.length).toBeGreaterThan(0);
			expect(label).not.toContain("—");
			expect(label.endsWith(".")).toBe(false);
		}
	});
});

describe("FIRST_PUBLISH_SAID_BY", () => {
	it("names only ids that have a sentence, with the same touchesWorkers", () => {
		for (const [id, by] of Object.entries(FIRST_PUBLISH_SAID_BY)) {
			expect(SAID_BY_ANOTHER.has(by)).toBe(false);
			expect(FIRST_PUBLISH_SENTENCES[by]).toBeDefined();
			expect(firstPublishSentenceId(id as FirstPublishChangeId)).toBe(by);
			expect(FIRST_PUBLISH_TOUCHES_WORKERS[id as FirstPublishChangeId]).toBe(
				FIRST_PUBLISH_TOUCHES_WORKERS[by],
			);
		}
	});
});

describe("firstPublishLines", () => {
	it("puts every line in its group, in registry order, each with its sentence", () => {
		const reversed = [...FIRST_PUBLISH_CHANGE_IDS].reverse();
		const lines = firstPublishLines(view(reversed), "review");
		const shown = [...lines.workers.lines, ...lines.hqOnly.lines];
		expect(shown.map((line) => line.id).sort()).toEqual(
			[...SENTENCE_IDS].sort(),
		);
		for (const line of shown) {
			expect(line.sentence).toBe(FIRST_PUBLISH_SENTENCES[line.id]);
		}
		expect(lines.workers.lines.map((line) => line.id)).toEqual(
			SENTENCE_IDS.filter((id) => FIRST_PUBLISH_TOUCHES_WORKERS[id]),
		);
		expect(lines.hqOnly.lines.map((line) => line.id)).toEqual(
			SENTENCE_IDS.filter((id) => !FIRST_PUBLISH_TOUCHES_WORKERS[id]),
		);
		expect(lines.workers.label).toBe(FIRST_PUBLISH_WORKERS_LABEL);
		expect(lines.hqOnly.label).toBe(FIRST_PUBLISH_HQ_LABEL);
	});

	it("shows two ids said by one sentence as one line", () => {
		const lines = firstPublishLines(
			view([
				"forms-and-settings-rewritten",
				"search-filter-rows-recut",
				"list-settings-respelled",
				"names-respelled",
				"media-maps-respelled",
			]),
			"publish",
		);
		expect(lines.workers.lines).toEqual([]);
		expect(lines.hqOnly.lines).toEqual([
			{
				id: "forms-and-settings-rewritten",
				sentence: FIRST_PUBLISH_SENTENCES["forms-and-settings-rewritten"],
			},
		]);
		const saidAlone = firstPublishLines(
			view(["names-respelled", "list-settings-respelled"], "next-publish"),
			"publish",
		);
		expect(saidAlone.hqOnly.lines.map((line) => line.id)).toEqual([
			"forms-and-settings-rewritten",
		]);
	});

	it("reassures exactly where no line touches workers", () => {
		const quiet = firstPublishLines(
			view(["forms-and-settings-rewritten", "hidden-values-added"]),
			"review",
		);
		expect(quiet.workers.lines).toEqual([]);
		expect(quiet.reassurance).toBe(FIRST_PUBLISH_NO_WORKER_CHANGE);

		const loud = firstPublishLines(
			view(["forms-and-settings-rewritten", "case-names-checked"]),
			"review",
		);
		expect(loud.workers.lines.map((line) => line.id)).toEqual([
			"case-names-checked",
		]);
		expect(loud.reassurance).toBeNull();
	});

	it("leads by surface for a first publish, and always notes the form builder", () => {
		const first = view(["forms-and-settings-rewritten"]);
		const review = firstPublishLines(first, "review");
		const publish = firstPublishLines(first, "publish");
		expect(review.heading).toBe(FIRST_PUBLISH_HEADING);
		expect(publish.heading).toBe(FIRST_PUBLISH_HEADING);
		expect(review.lead).toBe(FIRST_PUBLISH_LEAD_REVIEW);
		expect(publish.lead).toBe(FIRST_PUBLISH_LEAD_PUBLISH);
		expect(review.note).toBe(FIRST_PUBLISH_FORM_BUILDER_NOTE);
		expect(publish.note).toBe(FIRST_PUBLISH_FORM_BUILDER_NOTE);
	});

	it("heads a next publish with its own heading and lead, and builds the rest as for any list", () => {
		const ids: FirstPublishChangeId[] = [
			"location-list-setting-reset",
			"search-today-device-day",
		];
		const next = firstPublishLines(view(ids, "next-publish"), "publish");
		const first = firstPublishLines(view(ids, "first-publish"), "publish");
		expect(next.heading).toBe(NEXT_PUBLISH_HEADING);
		expect(next.lead).toBe(NEXT_PUBLISH_DIALOG_LEAD);
		expect({ ...next, heading: null, lead: null }).toEqual({
			...first,
			heading: null,
			lead: null,
		});
		expect(next.workers.lines.map((line) => line.id)).toEqual([
			"search-today-device-day",
		]);

		const quiet = firstPublishLines(
			view(["location-list-setting-reset"], "next-publish"),
			"publish",
		);
		expect(quiet.workers.lines).toEqual([]);
		expect(quiet.reassurance).toBe(FIRST_PUBLISH_NO_WORKER_CHANGE);
		const empty = firstPublishLines(view([], "next-publish"), "publish");
		expect(empty.hqOnly.lines).toEqual([]);
		expect(empty.note).toBe(FIRST_PUBLISH_FORM_BUILDER_NOTE);
	});

	it("refuses an id it has no words for", () => {
		const forged = {
			ids: ["not-registered" as FirstPublishChangeId],
			touchesWorkers: false,
			of: "first-publish",
		} satisfies FirstPublishView;
		expect(() => firstPublishLines(forged, "publish")).toThrow(
			/first-publish change it has no words for/,
		);
	});
});
