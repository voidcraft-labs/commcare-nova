import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

/** Dark CodeMirror theme matching the Nova design system. */
export const novaXPathTheme = createTheme({
	theme: "dark",
	settings: {
		background: "transparent",
		foreground: "#8888aa",
		caret: "#a78bfa",
		selection: "rgba(139, 92, 246, 0.2)",
		selectionMatch: "rgba(139, 92, 246, 0.1)",
		lineHighlight: "transparent",
		gutterBackground: "transparent",
		gutterForeground: "transparent",
		gutterBorder: "transparent",
		fontFamily: "var(--font-nova-mono)",
	},
	styles: [
		// CommCare hashtag refs (#case/prop, #form/question)
		{ tag: t.special(t.variableName), color: "#22d3ee" },
		// $variable references
		{ tag: t.variableName, color: "#a78bfa" },
		// Path segment names (data, items, question)
		{ tag: t.propertyName, color: "#e8e8ff" },
		{ tag: t.special(t.propertyName), color: "#e8e8ff" },
		// Functions
		{ tag: t.function(t.variableName), color: "#10b981" },
		// Strings
		{ tag: t.string, color: "#f59e0b" },
		// Numbers
		{ tag: t.number, color: "#f59e0b" },
		// Keywords (and, or, div, mod, axis names, ., ..)
		{ tag: t.keyword, color: "#c084fc" },
		// Operators (+, -, =, !=, etc.)
		{ tag: t.operator, color: "#8888aa" },
		// Path separators (/, //, ,)
		{ tag: t.separator, color: "#6366f1" },
		// Brackets [ ]
		{ tag: t.squareBracket, color: "#c084fc" },
		// Parens ( )
		{ tag: t.paren, color: "#f472b6" },
		// Axis/attribute markers (::, @)
		{ tag: t.meta, color: "#6366f1" },
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

/** Dark autocomplete tooltip theme matching Nova. */
export const novaAutocompleteTheme = EditorView.theme({
	".cm-tooltip": {
		zIndex: "200",
	},
	".cm-tooltip-autocomplete": {
		background: "#0d0d24",
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
		color: "#e8e8ff",
	},
	".cm-tooltip-autocomplete > ul > li[aria-selected]": {
		background: "rgba(139, 92, 246, 0.15)",
		color: "#e8e8ff",
	},
	".cm-completionDetail": {
		color: "#555577",
		fontStyle: "normal",
		marginLeft: "8px",
	},
	".cm-completionMatchedText": {
		color: "#a78bfa",
		textDecoration: "none",
	},
	".cm-completionIcon-function::after": { color: "#10b981" },
	".cm-completionIcon-property::after": { color: "#22d3ee" },
	".cm-completionIcon-variable::after": { color: "#a78bfa" },
	".cm-completionIcon-namespace::after": { color: "#22d3ee" },
	".cm-snippet-field": {
		background: "rgba(139, 92, 246, 0.15)",
		border: "1px solid rgba(139, 92, 246, 0.3)",
		borderRadius: "2px",
	},
});
