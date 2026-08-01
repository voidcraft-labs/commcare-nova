import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	FLOATING_LAYER_CLS,
	MENU_POSITIONER_CLS,
	POPOVER_POSITIONER_GLASS_CLS,
} from "@/lib/styles";
import { cn, getInitials, Z_INDEX_SCALE } from "@/lib/utils";

/** The z utilities left standing in a class string, in order. */
function zTokensIn(classes: string): string[] {
	return classes
		.split(/\s+/)
		.filter((cls) => /^z-(?!index)/.test(cls) && cls !== "z-auto");
}

describe("cn — Nova's z-index scale", () => {
	it("lets the last z token win", () => {
		// The bug this pins: an unextended tailwind-merge keeps both classes,
		// and generated-stylesheet order (alphabetical) then hands the win to
		// `z-popover-top` — so a select popup opened inside a dialog sat at 60
		// behind the dialog's 100 and was invisible.
		expect(cn("z-popover-top", "z-modal")).toBe("z-modal");
		expect(cn("z-modal", "z-popover-top")).toBe("z-popover-top");
		expect(cn("z-raised", "z-tooltip")).toBe("z-tooltip");
	});

	it("still merges the integer z utilities it always did", () => {
		expect(cn("z-10", "z-modal")).toBe("z-modal");
		expect(cn("z-modal", "z-auto")).toBe("z-auto");
	});

	it("leaves unrelated utilities alone", () => {
		expect(cn("isolate z-popover-top rounded-xl", "z-modal")).toBe(
			"isolate rounded-xl z-modal",
		);
	});

	it("resolves the shapes the floating primitives actually compose", () => {
		// The surface constants no longer carry a tier (`lib/styles.ts`), so these
		// compositions have nothing to arbitrate — one token in, one token out.
		// The scale stays taught to `cn` anyway: it is what makes a LATER `z-*`
		// genuinely replace an earlier one, so a call site that does need to
		// override a plane gets the tier it asked for instead of whichever token
		// happens to sort last in the generated stylesheet.
		for (const surface of [MENU_POSITIONER_CLS, POPOVER_POSITIONER_GLASS_CLS]) {
			expect(zTokensIn(cn(FLOATING_LAYER_CLS, surface))).toEqual(["z-modal"]);
			expect(zTokensIn(cn(FLOATING_LAYER_CLS, surface, "z-tooltip"))).toEqual([
				"z-tooltip",
			]);
		}
	});

	it("matches the --z-index-* keys declared in globals.css", () => {
		const css = readFileSync(
			path.join(process.cwd(), "app/globals.css"),
			"utf8",
		);
		const declared = [...css.matchAll(/--z-index-([a-z-]+):/g)].map(
			(match) => match[1],
		);
		expect(declared.length).toBeGreaterThan(0);
		expect([...declared].sort()).toEqual([...Z_INDEX_SCALE].sort());
	});
});

describe("getInitials", () => {
	it("takes the first code point of up to two words, uppercased", () => {
		expect(getInitials("Ann Lee")).toBe("AL");
		expect(getInitials("  bo  ")).toBe("B");
		expect(getInitials("Ann van der Berg")).toBe("AV");
	});

	it("never splits a surrogate pair (non-BMP first characters)", () => {
		// `word[0]` indexes by UTF-16 code unit and would yield a lone high
		// surrogate ("�") for these.
		expect(getInitials("𝕊am Jones")).toBe("𝕊J");
		expect(getInitials("😀 Smith")).toBe("😀S");
		expect(getInitials("😀")).toBe("😀");
	});

	it("falls back to ? for an empty / whitespace-only name", () => {
		expect(getInitials("")).toBe("?");
		expect(getInitials("   ")).toBe("?");
	});
});
