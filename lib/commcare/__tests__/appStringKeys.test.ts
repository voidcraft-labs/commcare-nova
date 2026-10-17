/**
 * The owner of an app string key, held to the generated surface's
 * `app-string-id:` items, which are HQ's `id_strings.py::REGEXES`. Pure.
 */
import { describe, expect, it } from "vitest";
import {
	GENERATED_APP_STRING_PATTERNS,
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

describe("translationKeyOwner", () => {
	it("reads every generated pattern of the surface but the target's own", () => {
		expect(PATTERNS).toContain("homescreen.title");
		expect(PATTERNS).toContain("android.package.name.*");
		expect(GENERATED_APP_STRING_PATTERNS).toEqual(
			PATTERNS.filter((pattern) => pattern !== "android.package.name.*"),
		);
	});

	it("classes a key every generated pattern names as generated", () => {
		for (const pattern of GENERATED_APP_STRING_PATTERNS)
			expect(translationKeyOwner(sample(pattern), []), pattern).toBe(
				"generated",
			);
		for (const key of [
			"homescreen.title",
			"app.display.name",
			"modules.m0",
			"forms.m3f12",
			"m0_select_text",
			"m2_no_items_text",
		])
			expect(translationKeyOwner(key, []), key).toBe("generated");
	});

	it("leaves the package name and every runtime catalog key to the target", () => {
		for (const key of ["android.package.name.x", "home.start", "sync.button"])
			expect(translationKeyOwner(key, ["en"]), key).toBe("target");
	});

	it("matches a pattern at the key's start, as HQ's `re.match` does", () => {
		// `modules.m%d` names `modules.m0.extra` too; `%d` needs a digit.
		expect(translationKeyOwner("modules.m0.extra", [])).toBe("generated");
		expect(translationKeyOwner("modules.mx", [])).toBe("target");
		expect(translationKeyOwner("xmodules.m0", [])).toBe("target");
	});

	it("names a language's wire code as its name, and only a current one", () => {
		expect(translationKeyOwner("fra", ["en", "fra"])).toBe("language-name");
		expect(translationKeyOwner("fra", ["en"])).toBe("target");
	});
});
