/**
 * A publish holds every build profile of the app on CommCare HQ to the
 * codes it writes as `langs`. A check that read other codes than the body
 * writes would pass a stale profile or stop a publish that leaves none, so
 * the codes are held equal to both bodies' `langs` on a document whose
 * codes are not the identities' own spellings.
 */

import { describe, expect, it } from "vitest";
import { expandAppShell, expandDoc } from "../expander";
import type { HqBuildProfile } from "../hq/appSource";
import {
	buildProfileLanguageGaps,
	buildProfileLanguageLabel,
	publishedLanguageCodes,
} from "../targetBuildProfiles";
import { localizationWireFixture } from "./localizationWireFixture";

const profile = (
	id: string,
	langs: readonly string[],
	name = id,
): HqBuildProfile => ({ id, name, langs });

describe("buildProfileLanguageGaps", () => {
	const langs = ["en", "fra", "hau"];

	it("gives no gap for a profile inside the app's languages", () => {
		expect(
			buildProfileLanguageGaps(langs, [profile("all", ["fra", "en"])]),
		).toEqual([]);
	});

	it("names the codes outside, in the profile's order, where the profile keeps another", () => {
		expect(
			buildProfileLanguageGaps(langs, [
				profile("field", ["swa", "en", "zho"], "Field team"),
			]),
		).toEqual([
			{
				id: "field",
				name: "Field team",
				missing: ["swa", "zho"],
				emptied: false,
			},
		]);
	});

	it("marks a profile that names no language the app has as emptied", () => {
		expect(
			buildProfileLanguageGaps(langs, [profile("mandarin", ["zho"], "")]),
		).toEqual([{ id: "mandarin", name: "", missing: ["zho"], emptied: true }]);
	});

	it("gives no gap for a profile with no languages", () => {
		expect(buildProfileLanguageGaps(langs, [profile("empty", [])])).toEqual([]);
	});

	it("keeps HQ's profile order and passes over the profiles that fit", () => {
		expect(
			buildProfileLanguageGaps(langs, [
				profile("b", ["zho"]),
				profile("fits", ["en"]),
				profile("a", ["en", "swa"]),
			]).map((gap) => gap.id),
		).toEqual(["b", "a"]);
	});
});

describe("publishedLanguageCodes", () => {
	it("equals the langs both bodies write, a suffixed code included", () => {
		const doc = localizationWireFixture("mandarin");
		const codes = publishedLanguageCodes(doc);
		expect(codes).toEqual(["en", "zho", "cmn-hant"]);
		expect(codes).toEqual(expandDoc(doc).langs);
		expect(codes).toEqual(expandAppShell(doc).langs);
	});
});

describe("buildProfileLanguageLabel", () => {
	it("writes a catalog language as its English name and the code HQ holds, and any other code alone", () => {
		expect(buildProfileLanguageLabel("fra")).toBe("French (fra)");
		expect(buildProfileLanguageLabel("en")).toBe("English (en)");
		expect(buildProfileLanguageLabel("cmn-hant")).toBe("cmn-hant");
	});
});
