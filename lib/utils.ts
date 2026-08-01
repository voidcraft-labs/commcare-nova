import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Nova's z-index scale (`app/globals.css` → the `--z-index-*` theme keys).
 *
 * tailwind-merge treats `z-index` as a class group whose values are integers or
 * `auto`, so it does not recognize these NAMED tokens as members of it. Left
 * unextended, `cn("z-popover-top", "z-modal")` keeps BOTH classes and the winner
 * falls to generated-stylesheet order — which sorts the tokens alphabetically,
 * so `z-popover-top` beats `z-modal` and a menu opened from inside a dialog
 * paints behind it. Listing the scale here restores the contract every call site
 * assumes: the last z token wins.
 *
 * Floating chrome no longer leans on that (`lib/styles.ts` keeps the stacking
 * plane out of the surface constants, so a positioner names exactly one tier).
 * This stays load-bearing for the deliberate override — a surface that must
 * leave the shared plane gets the tier it asked for rather than whichever token
 * happens to sort last.
 *
 * Keep in sync with the `--z-index-*` keys in `app/globals.css`; the unit test
 * beside this file reads that file and fails when the two drift.
 */
export const Z_INDEX_SCALE = [
	"ground",
	"raised",
	"popover",
	"popover-top",
	"tooltip",
	"modal",
	"system",
] as const;

const twMerge = extendTailwindMerge({
	// `z` is tailwind-merge's own id for the z-index group — extending any other
	// id would quietly build a SECOND group, where the named tokens resolve
	// against each other but never against `z-10`.
	extend: { classGroups: { z: [{ z: [...Z_INDEX_SCALE] }] } },
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Up to two initials from a display name, uppercased — the account-menu avatar,
 * the presence roster, and the canvas peer markers all label an avatar with it,
 * so a name-rendering tweak lands in one place. Falls back to "?" for an
 * empty / whitespace-only name.
 */
export function getInitials(name: string): string {
	// Take each word's first CODE POINT (the string iterator), never `word[0]`
	// — indexing is by UTF-16 code unit, so a name starting with a non-BMP
	// character (an emoji, astral-plane CJK) would split the surrogate pair
	// and render "�".
	const initials = name
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => [...word][0] ?? "");
	if (initials.length >= 2) {
		return `${initials[0]}${initials[1]}`.toUpperCase();
	}
	return initials[0]?.toUpperCase() || "?";
}
