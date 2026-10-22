import {
	foldInside,
	foldNodeProp,
	LanguageSupport,
	LRLanguage,
} from "@codemirror/language";
import type { NodeType } from "@lezer/common";
import { styleTags, tags as t } from "@lezer/highlight";
import { parser } from "@/lib/commcare/xpath";

const xpathHighlighting = styleTags({
	// Data references — all parts of a hashtag ref share the same style
	"HashtagRef HashtagType HashtagSegment": t.special(t.variableName),
	'HashtagRef/"/" HashtagRef/"#"': t.special(t.variableName),
	VariableReference: t.variableName,
	// Names (path segments, element names)
	"NameTest QualifiedWildcard": t.propertyName,
	Wildcard: t.special(t.propertyName),
	// Functions
	FunctionName: t.function(t.variableName),
	// Literals
	StringLiteral: t.string,
	NumberLiteral: t.number,
	// Keywords (and, or, div, mod, axis names, ., ..)
	Keyword: t.keyword,
	AxisName: t.keyword,
	"SelfStep ParentStep": t.keyword,
	// Operators
	'"*" "+" "-" "|" ">" ">=" "<" "<=" "=" "!="': t.operator,
	// Path separators
	'"/" "//"': t.separator,
	// Brackets and delimiters
	'"[" "]"': t.squareBracket,
	'"(" ")"': t.paren,
	'","': t.separator,
	// Axis / attribute markers
	'"::" "@"': t.meta,
	RootPath: t.separator,
});

export const xpathLanguage = LRLanguage.define({
	name: "xpath",
	parser: parser.configure({
		props: [
			xpathHighlighting,
			foldNodeProp.add({
				ArgumentList: foldInside,
				Filtered: foldInside,
			}),
		],
	}),
});

/** The node types of the editor's own tree with this name. The language
 * configures the parser with its props, which gives its tree its own
 * `NodeType`s, so an editor-tree consumer compares against these, never the
 * bare parser's. A name can have several types: the grammar's root step and
 * its relative step are both `Child`. */
export function xpathNodeTypes(name: string): ReadonlySet<NodeType> {
	const types = xpathLanguage.parser.nodeSet.types.filter(
		(candidate) => candidate.name === name,
	);
	if (types.length === 0) throw new Error(`The XPath grammar has no ${name}.`);
	return new Set(types);
}

export function xpath() {
	return new LanguageSupport(xpathLanguage);
}
