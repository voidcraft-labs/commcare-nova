/**
 * The owner of an app string key, held to the generated surface's
 * `app-string-id:` items, which are HQ's `id_strings.py::REGEXES`; and the
 * project space's text HQ's build merges into an app's `default` strings,
 * held to the catalogs the surface's `ui-string:` items name. Pure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultAppStringsHeldText,
	GENERATED_APP_STRING_PATTERNS,
	hqCatalogMayHold,
	translationKeyOwner,
} from "../appStringKeys";
import surface from "../surface/surface.json";

const PATTERNS = Object.keys(
	(surface as { readonly items: Record<string, unknown> }).items,
)
	.filter((key) => key.startsWith("app-string-id:"))
	.map((key) => key.slice("app-string-id:".length));

/** One key each pattern names: `*` as some text, `#` as some digits. */
function sample(pattern: string): string {
	return pattern.replaceAll("*", "x_1").replaceAll("#", "12");
}

/** No language codes. */
const NO_CODES: ReadonlySet<string> = new Set();

describe("translationKeyOwner", () => {
	it("reads every generated pattern of the surface but the target's own", () => {
		expect(PATTERNS).toContain("homescreen.title");
		expect(PATTERNS).toContain("android.package.name.*");
		expect(GENERATED_APP_STRING_PATTERNS).toEqual(
			PATTERNS.filter((pattern) => pattern !== "android.package.name.*"),
		);
	});

	it("recognizes each generated pattern and leaves the training runtime title in the catalog", () => {
		for (const pattern of GENERATED_APP_STRING_PATTERNS)
			expect(translationKeyOwner(sample(pattern), NO_CODES), pattern).toBe(
				pattern === "training.root.title" ? "target" : "generated",
			);
		for (const key of [
			"homescreen.title",
			"app.display.name",
			"modules.m0",
			"forms.m3f12",
			"m0_select_text",
			"m2_no_items_text",
		])
			expect(translationKeyOwner(key, NO_CODES), key).toBe("generated");
	});

	it("leaves the package name and every runtime catalog key to the target", () => {
		for (const key of ["android.package.name.x", "home.start", "sync.button"])
			expect(translationKeyOwner(key, new Set(["en"])), key).toBe("target");
	});

	it("matches a pattern at the key's start, as HQ's `re.match` does", () => {
		// `modules.m%d` names `modules.m0.extra` too; `%d` needs a digit.
		expect(translationKeyOwner("modules.m0.extra", NO_CODES)).toBe("generated");
		expect(translationKeyOwner("modules.mx", NO_CODES)).toBe("target");
		expect(translationKeyOwner("xmodules.m0", NO_CODES)).toBe("target");
	});

	it("asks the language codes one lookup a key, never a walk of them", () => {
		// Plausible failure: a key judged by walking every language, which an HQ app's long
		// language list makes keys times languages on every read and publish of it.
		class Unwalkable extends Set<string> {
			override [Symbol.iterator](): SetIterator<string> {
				throw new Error("The codes were walked.");
			}
			override forEach(): void {
				throw new Error("The codes were walked.");
			}
		}
		const codes = new Unwalkable(["en", "fra"]);
		expect(translationKeyOwner("fra", codes)).toBe("language-name");
		expect(translationKeyOwner("home.start", codes)).toBe("target");
	});

	it("names a language's wire code as its name, and only a current one", () => {
		expect(translationKeyOwner("fra", new Set(["en", "fra"]))).toBe(
			"language-name",
		);
		expect(translationKeyOwner("fra", new Set(["en"]))).toBe("target");
	});

	/* HQ's build writes `key.strip()` on one line (`commcare_translations.py::dumps`),
	 * so a key is the string it sets there: an override of a generated string
	 * with a space before it is the generated string's, and a key that is no
	 * one locale record of its own name is no one's to carry. */
	it("judges a key as HQ's build writes it, stripped", () => {
		const nbsp = String.fromCharCode(0xa0);
		expect(translationKeyOwner(" modules.m0", NO_CODES)).toBe("generated");
		expect(translationKeyOwner(`${nbsp}forms.m0f0`, NO_CODES)).toBe(
			"generated",
		);
		expect(translationKeyOwner("\tfra", new Set(["en", "fra"]))).toBe(
			"language-name",
		);
		expect(translationKeyOwner(" home.start ", new Set(["en"]))).toBe("target");
	});

	it("gives a key that sets another string than its own name, or none, to no one", () => {
		for (const key of [
			"x=y\nmodules.m0",
			"modules.m0\rx",
			"a=b",
			"a#b",
			"",
			"   ",
			`home.start${String.fromCharCode(0x01)}`,
		])
			expect(
				translationKeyOwner(key, new Set(["en"])),
				JSON.stringify(key),
			).toBe("not-its-own");
	});

	/* The proof lane judges what Nova's publish and archive carry back by its
	 * own reading of this rule (`proof/checks/compare/app_strings.py::
	 * translation_key_owner`), which `proof/checks/test_translation_keys.py`
	 * holds to the same rows: a mirror that drifts from Nova's rule fails there
	 * or here. */
	it("answers every row the proof lane's mirror is held to", () => {
		const fixture = JSON.parse(
			readFileSync(
				join(
					process.cwd(),
					"proof/checks/fixtures/translation-key-owners.json",
				),
				"utf8",
			),
		) as {
			readonly vectors: readonly {
				readonly key: string;
				readonly codes: readonly string[];
				readonly owner: string;
			}[];
		};
		expect(fixture.vectors.length).toBeGreaterThan(0);
		for (const vector of fixture.vectors)
			expect(
				translationKeyOwner(vector.key, new Set(vector.codes)),
				JSON.stringify(vector.key),
			).toBe(vector.owner);
	});
});

describe("hqCatalogMayHold", () => {
	it("reads the catalog HQ's loader reads for the language", () => {
		expect(hqCatalogMayHold("home.start", "en")).toBe(true);
		expect(hqCatalogMayHold("home.start", "fra")).toBe(false);
		// Hindi reads `messages_hin-1.txt`, which holds keys English's does not.
		expect(hqCatalogMayHold("Back", "hin")).toBe(true);
		expect(hqCatalogMayHold("Back", "en")).toBe(false);
		// `pt` reads `por`.
		expect(hqCatalogMayHold("sending.view.done", "pt")).toBe(true);
		expect(hqCatalogMayHold("sending.view.done", "hin")).toBe(false);
		expect(hqCatalogMayHold("custom.greeting", "en")).toBe(false);
	});

	it("reads every English catalog, since the app's version picks one", () => {
		// Held by older English catalogs, not by the current one.
		expect(hqCatalogMayHold("archive.install.button", "en")).toBe(true);
		// Only `messages_en-1.txt`, which the loader never reaches past `-2`.
		expect(hqCatalogMayHold("case_sharing.exactly_one_group", "en")).toBe(
			false,
		);
	});

	it("gives every language the ids HQ adds to each catalog", () => {
		expect(hqCatalogMayHold("cchq.case", "fra")).toBe(true);
	});

	it("reads a key as the upstream text spells it", () => {
		expect(hqCatalogMayHold("\u{feff}polish.command.ok", "hin")).toBe(true);
	});
});

describe("defaultAppStringsHeldText", () => {
	it("takes the first language's text, then the next language's", () => {
		expect(
			defaultAppStringsHeldText(
				{
					fra: { "custom.greeting": "Bonjour", "custom.farewell": "Salut" },
					en: { "custom.greeting": "Hello" },
				},
				["en", "fra"],
			),
		).toEqual({ "custom.greeting": "Hello", "custom.farewell": "Salut" });
	});

	it("takes nothing past a language whose catalog may hold the key", () => {
		expect(
			defaultAppStringsHeldText({ fra: { "home.start": "Commencer" } }, [
				"en",
				"fra",
			]),
		).toEqual({});
		expect(
			defaultAppStringsHeldText({ en: { Back: "Go back" } }, [
				"fra",
				"hin",
				"en",
			]),
		).toEqual({});
		expect(
			defaultAppStringsHeldText({ en: { "home.start": "Begin" } }, [
				"fra",
				"en",
			]),
		).toEqual({ "home.start": "Begin" });
	});

	/* Worked from `create_default_app_strings`: each language's text is read
	 * back by `commcare_translations.loads` from what `dumps` wrote, a blank
	 * as `""`, and a blank never replaces a text already merged. */
	it("never takes a blank text over a later language's text", () => {
		expect(
			defaultAppStringsHeldText(
				{
					en: { "home.start": " ", "custom.greeting": " " },
					fra: { "home.start": "Commencer" },
				},
				["en", "fra", "hin"],
			),
		).toEqual({ "home.start": "Commencer", "custom.greeting": "" });
		expect(
			defaultAppStringsHeldText(
				{ en: { "custom.greeting": " " }, fra: { "custom.greeting": "\t" } },
				["en", "fra"],
			),
		).toEqual({ "custom.greeting": "" });
	});

	it("takes nothing where a blank stands before a language whose catalog may hold the key", () => {
		expect(
			defaultAppStringsHeldText({ fra: { "home.start": " " } }, ["fra", "en"]),
		).toEqual({});
	});

	it("drops the spaces at a text's end as HQ's read of its own strings does", () => {
		expect(
			defaultAppStringsHeldText(
				{ en: { "custom.greeting": "Hello  ", "custom.farewell": "Bye \n " } },
				["en"],
			),
		).toEqual({ "custom.greeting": "Hello", "custom.farewell": "Bye \n" });
	});

	it("writes nothing for a language the app does not have", () => {
		expect(
			defaultAppStringsHeldText({ spa: { "custom.greeting": "Hola" } }, [
				"en",
				"fra",
			]),
		).toEqual({});
	});
});
