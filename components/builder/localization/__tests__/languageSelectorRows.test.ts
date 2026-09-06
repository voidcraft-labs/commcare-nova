import { expect, it } from "vitest";
import { loadLanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";
import { languageSelectorRows } from "../languageSelectorRows";

it("keeps app ordering and derives endonyms, accessible English names and script direction", () => {
	const rows = languageSelectorRows([
		{ tag: "kas-Arab", identity: { language: "kas", script: "Arab" } },
		{ tag: "eng", identity: { language: "eng" } },
		{ tag: "kas-Deva", identity: { language: "kas", script: "Deva" } },
	]);
	expect(
		rows.map(({ tag, direction, qualifier }) => ({
			tag,
			direction,
			qualifier,
		})),
	).toEqual([
		{ tag: "kas-Arab", direction: "rtl", qualifier: "Arabic" },
		{ tag: "eng", direction: "ltr", qualifier: undefined },
		{ tag: "kas-Deva", direction: "ltr", qualifier: "Devanagari" },
	]);
	expect(rows[1]).toMatchObject({ label: "English", englishName: "English" });
});

it("disambiguates the general language only when a qualified sibling exists", () => {
	const general = { tag: "spa", identity: { language: "spa" } };
	expect(languageSelectorRows([general])[0]?.qualifier).toBeUndefined();
	const rows = languageSelectorRows([
		general,
		{ tag: "spa-MX", identity: { language: "spa", region: "MX" } },
	]);
	expect(rows[0]).toMatchObject({
		label: "Español",
		englishName: "Spanish",
		qualifier: "General",
	});
	expect(rows[1]).toMatchObject({
		label: "Español de México",
		englishName: "Spanish (Mexico)",
		qualifier: "Mexico",
	});
});

it("leaves unknown baked labels pending until the real lazy registry resolves them", async () => {
	const languages = [{ tag: "hne", identity: { language: "hne" } }];
	expect(languageSelectorRows(languages)[0]).toMatchObject({
		label: undefined,
		englishName: undefined,
	});
	const registry = await loadLanguageRegistrySearch();
	expect(languageSelectorRows(languages, registry)[0]).toMatchObject({
		label: "Chhattisgarhi",
		englishName: "Chhattisgarhi",
	});
});
