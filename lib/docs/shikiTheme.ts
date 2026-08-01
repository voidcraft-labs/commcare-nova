/**
 * The Nova syntax theme for docs code blocks.
 *
 * The design system publishes a 12-step code palette ("lavender milk bath",
 * the `--nova-code-*` tokens) and says in as many words: no borrowed blues.
 * fumadocs ships GitHub Light/Dark by default, which put `#79b8ff` on JSON
 * keys and `#f97583` on shell keywords, so every fenced block on the docs
 * site was rendering in someone else's palette.
 *
 * Shiki resolves colors at build time, so a theme object is the only place
 * this can be fixed: the tokens cannot be referenced as `var(--nova-code-*)`
 * because the emitted markup carries literal hex in inline styles. The
 * values below are copied from `tokens/colors.css` and must move with it.
 *
 * The app is dark-only, so the same theme is registered for both slots and
 * a light-mode leak is impossible.
 */
import type { ThemeRegistrationRaw } from "shiki";

/** `--nova-code-*`, in the order the design package lists them. */
const CODE = {
	fg: "#bebcdc",
	ref: "#b6b2e6",
	var: "#928fd6",
	name: "#dfdeed",
	fn: "#a08ae0",
	string: "#cda0d4",
	number: "#d9b8e0",
	keyword: "#a797ce",
	op: "#7e79b9",
	paren: "#9e9bca",
	bracket: "#8974be",
	sep: "#5d58a7",
} as const;

const NOVA_CODE_THEME_BASE: ThemeRegistrationRaw = {
	name: "nova",
	type: "dark",
	/* Transparent, because the block's own surface is Nova's card, drawn by
	 * `.nova-docs figure.shiki` in globals.css. */
	bg: "transparent",
	fg: CODE.fg,
	settings: [
		{ settings: { foreground: CODE.fg, background: "transparent" } },
		{
			scope: ["comment", "punctuation.definition.comment"],
			settings: { foreground: CODE.sep, fontStyle: "italic" },
		},
		{
			scope: ["string", "constant.other.symbol", "string.regexp"],
			settings: { foreground: CODE.string },
		},
		{
			scope: ["constant.numeric", "constant.language", "constant.character"],
			settings: { foreground: CODE.number },
		},
		{
			scope: [
				"keyword",
				"storage",
				"storage.type",
				"keyword.control",
				"keyword.operator.new",
			],
			settings: { foreground: CODE.keyword },
		},
		{
			scope: [
				"entity.name.function",
				"support.function",
				"meta.function-call",
				"entity.name.tag",
			],
			settings: { foreground: CODE.fn },
		},
		{
			scope: [
				"variable",
				"variable.other",
				"variable.parameter",
				"meta.definition.variable",
			],
			settings: { foreground: CODE.var },
		},
		/* Object and JSON keys, path segments: the brightest step, the "nouns". */
		{
			scope: [
				"support.type.property-name",
				"meta.object-literal.key",
				"entity.name.type",
				"support.type",
				"support.class",
				"entity.other.attribute-name",
			],
			settings: { foreground: CODE.name },
		},
		{
			scope: [
				"keyword.operator",
				"punctuation.separator",
				"punctuation.terminator",
			],
			settings: { foreground: CODE.op },
		},
		{
			scope: [
				"meta.brace",
				"punctuation.section",
				"punctuation.definition.parameters",
			],
			settings: { foreground: CODE.paren },
		},
		{
			scope: [
				"punctuation.definition.list",
				"punctuation.definition.array",
				"meta.structure.dictionary",
			],
			settings: { foreground: CODE.bracket },
		},
		/* Hashtag refs read as references wherever a grammar surfaces them. */
		{
			scope: ["variable.other.constant", "support.constant"],
			settings: { foreground: CODE.ref },
		},
	],
};

/**
 * fumadocs registers a light and a dark slot and keys the registry by theme
 * `name`, so handing it the same object twice collapses both to one entry and
 * every token falls back to the default foreground. Two distinctly-named
 * copies of the same theme keep the registry honest; the app is dark-only, so
 * they are deliberately identical.
 */
export const NOVA_CODE_THEME_DARK: ThemeRegistrationRaw = {
	...NOVA_CODE_THEME_BASE,
	name: "nova-dark",
};
export const NOVA_CODE_THEME_LIGHT: ThemeRegistrationRaw = {
	...NOVA_CODE_THEME_BASE,
	name: "nova-light",
};
