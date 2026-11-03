/** Where the guide places each generated platform sentence: right after the
 * sentence that introduces its feature, so the sentence's referent is the one
 * before it. It pins the placement, not the prose, which the platform table
 * owns. */
import { describe, expect, it } from "vitest";
import {
	featureForFieldKind,
	fieldKinds,
	type PlatformFeatureId,
	platformSentence,
	platformSentenceForFieldKind,
} from "@/lib/domain";
import { AUTHORING_REFERENCE } from "../reference";

describe("the guide's platform sentences", () => {
	it("ends each platform-feature kind's line in the field list with its sentence", () => {
		const lines = AUTHORING_REFERENCE.fields().split("\n");
		const featured = fieldKinds.filter(
			(kind) => featureForFieldKind(kind) !== undefined,
		);
		expect(featured.length).toBeGreaterThan(0);
		for (const kind of featured) {
			const sentence = platformSentenceForFieldKind(kind);
			expect(sentence).not.toBe("");
			const line = lines.find((each) => each.startsWith(`${kind}: `));
			expect(line?.endsWith(` ${sentence}`), kind).toBe(true);
		}
		for (const kind of fieldKinds.filter(
			(each) => featureForFieldKind(each) === undefined,
		))
			expect(platformSentenceForFieldKind(kind)).toBe("");
	});

	it.each<[keyof typeof AUTHORING_REFERENCE, string, PlatformFeatureId]>([
		[
			"workflows",
			"A several-case form applies one shared answer to each selected record.",
			"several-cases",
		],
		[
			"workflows",
			"listFirst opens on the case list, with Search from it.",
			"search-first",
		],
		[
			"workflows",
			"formsReadSearch runs the search as each form in the menu opens, so its forms read what was searched for and what was found.",
			"forms-read-search",
		],
		[
			"workflows",
			"case_list_menu_item shows a menu's case list as its own item, beside its forms or alone.",
			"case-list-menu-item",
		],
		[
			"workflows",
			"After a form, every destination whose condition holds runs, in the order you set: the first opens, and each next one opens when the worker finishes the one before.",
			"after-submit-several-destinations",
		],
		[
			"expressions",
			"here() is the worker's current GPS position, a geopoint, available only in a calculated Results or Details column.",
			"case-list-here",
		],
		[
			"expressions",
			"instance('commcaresession')/session/context/drift is the device clock's offset from the server's in whole hours, a whole number.",
			"clock-drift",
		],
		[
			"expressions",
			"compare it with a language's commcareCode, which getLanguages lists.",
			"app-language",
		],
		[
			"expressions",
			"a module's display condition, case list and Search settings and a form's display condition can read it, and no rule a form evaluates can.",
			"window-width",
		],
		[
			"expressions",
			"reads what the worker typed into that list's search box, blank when nothing.",
			"case-list-search-text",
		],
	])("in %s, follows %j with %s's sentence", (topic, introduction, feature) => {
		const sentence = platformSentence(feature);
		expect(sentence).not.toBe("");
		expect(AUTHORING_REFERENCE[topic]()).toContain(
			`${introduction} ${sentence}`,
		);
	});

	// The search paragraph introduces its three workflows in one sentence,
	// so their generated sentences follow it in the order it names them.
	it("follows the workflows' sentence with search first's, results first's and case list first's sentences in turn", () => {
		const introduction =
			"listFirst opens on the case list, with Search from it.";
		const sentences = (
			["search-first", "skip-to-results", "list-first"] as const
		).map((feature) => platformSentence(feature));
		for (const sentence of sentences) expect(sentence).not.toBe("");
		expect(AUTHORING_REFERENCE.workflows()).toContain(
			[introduction, ...sentences].join(" "),
		);
	});
});
