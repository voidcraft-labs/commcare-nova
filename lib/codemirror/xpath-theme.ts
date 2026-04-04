import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

/**
 * Dark CodeMirror theme — "lavender milk bath in space."
 *
 * All syntax colors live in the purple/lavender/orchid family. Differentiation
 * comes from lightness and warmth shifts, not clashing hues:
 *   - Cool periwinkle for references and variables
 *   - Neutral lavender for structure (operators, separators, brackets)
 *   - Warm orchid for literals (strings, numbers)
 *   - Bright lavender-white for path names (the "nouns")
 */
export const novaXPathTheme = createTheme({
	theme: "dark",
	settings: {
		background: "transparent",
		foreground: "#bebcdc", // lavender-200 — base code color
		caret: "#b6b4e4", // periwinkle-200
		selection: "rgba(139, 92, 246, 0.2)",
		selectionMatch: "rgba(139, 92, 246, 0.1)",
		lineHighlight: "transparent",
		gutterBackground: "transparent",
		gutterForeground: "transparent",
		gutterBorder: "transparent",
		fontFamily: "var(--font-nova-mono)",
	},
	styles: [
		// CommCare hashtag refs (#case/prop, #form/question) — periwinkle, nudged toward nova-violet
		{ tag: t.special(t.variableName), color: "#b6b2e6" }, // deep-navy-200 (closer to brand violet)
		// $variable references — cool periwinkle
		{ tag: t.variableName, color: "#928fd6" }, // periwinkle-300
		// Path segment names (data, items, question) — brightest, the "nouns" of XPath
		{ tag: t.propertyName, color: "#dfdeed" }, // lavender-100
		{ tag: t.special(t.propertyName), color: "#dfdeed" },
		// Functions — brighter, anchored toward nova-violet-bright for brand tie-in
		{ tag: t.function(t.variableName), color: "#a08ae0" }, // between deep-navy-300 and violet-bright
		// Strings — warm orchid, slightly boosted for cream
		{ tag: t.string, color: "#cda0d4" }, // pink-orchid-300 nudged warmer
		// Numbers — lighter orchid
		{ tag: t.number, color: "#d9b8e0" }, // pink-orchid-200
		// Keywords (and, or, div, mod, axis names, ., ..) — warm purple emphasis
		{ tag: t.keyword, color: "#a797ce" }, // lavender-purple-300
		// Operators (+, -, =, !=, etc.) — subdued structural
		{ tag: t.operator, color: "#7e79b9" }, // lavender-400
		// Path separators (/, //, ,) — dim structural
		{ tag: t.separator, color: "#5d58a7" }, // lavender-500
		// Brackets [ ] — medium purple
		{ tag: t.squareBracket, color: "#8974be" }, // lavender-purple-400
		// Parens ( ) — softer than keywords, structural
		{ tag: t.paren, color: "#9e9bca" }, // lavender-300
		// Axis/attribute markers (::, @) — structural
		{ tag: t.meta, color: "#5d58a7" }, // lavender-500
	],
});

/** Chip widget styles — subtle hover feedback for reference chips. */
export const novaChipTheme = EditorView.theme({
	".cm-hashtag-chip": {
		transition: "filter 0.1s ease",
	},
	".cm-hashtag-chip:hover": {
		filter: "brightness(1.2)",
	},
});

/** Dark autocomplete tooltip theme matching the lavender palette. */
export const novaAutocompleteTheme = EditorView.theme({
	".cm-tooltip": {
		zIndex: "200",
	},
	".cm-tooltip-autocomplete": {
		background: "#0f0c27", // deep-navy-900
		border: "1px solid rgba(139, 92, 246, 0.2)",
		borderRadius: "8px",
		boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)",
		fontFamily: "var(--font-nova-mono)",
		fontSize: "12px",
	},
	".cm-tooltip-autocomplete > ul": {
		maxHeight: "200px",
	},
	".cm-tooltip-autocomplete > ul > li": {
		padding: "3px 8px",
		color: "#dfdeed", // lavender-100
	},
	".cm-tooltip-autocomplete > ul > li[aria-selected]": {
		background: "rgba(139, 92, 246, 0.15)",
		color: "#efeef6", // lavender-50
	},
	".cm-completionDetail": {
		color: "#7e79b9", // lavender-400
		fontStyle: "normal",
		marginLeft: "8px",
	},
	".cm-completionMatchedText": {
		color: "#b6b4e4", // periwinkle-200
		textDecoration: "none",
	},
	".cm-completionIcon-function::after": { color: "#a08ae0" }, // matches function syntax color
	".cm-completionIcon-property::after": { color: "#dfdeed" }, // lavender-100
	".cm-completionIcon-variable::after": { color: "#928fd6" }, // periwinkle-300
	".cm-completionIcon-namespace::after": { color: "#b6b4e4" }, // periwinkle-200
	".cm-snippet-field": {
		background: "rgba(139, 92, 246, 0.12)",
		border: "1px solid rgba(139, 92, 246, 0.25)",
		borderRadius: "2px",
	},
});
