import { LRLanguage, LanguageSupport, foldNodeProp, foldInside } from '@codemirror/language'
import { styleTags, tags as t } from '@lezer/highlight'
import { parser } from './xpath-parser'

const xpathHighlighting = styleTags({
  // Data references — all parts of a hashtag ref share the same style
  'HashtagRef HashtagType HashtagSegment': t.special(t.variableName),
  'HashtagRef/"/" HashtagRef/"#"': t.special(t.variableName),
  VariableReference: t.variableName,
  // Names (path segments, element names)
  'NameTest QualifiedWildcard': t.propertyName,
  Wildcard: t.special(t.propertyName),
  // Functions
  FunctionName: t.function(t.variableName),
  // Literals
  StringLiteral: t.string,
  NumberLiteral: t.number,
  // Keywords (and, or, div, mod, axis names, ., ..)
  Keyword: t.keyword,
  AxisName: t.keyword,
  'SelfStep ParentStep': t.keyword,
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
})

export const xpathLanguage = LRLanguage.define({
  name: 'xpath',
  parser: parser.configure({
    props: [
      xpathHighlighting,
      foldNodeProp.add({
        ArgumentList: foldInside,
        Filtered: foldInside,
      }),
    ],
  }),
})

export function xpath() {
  return new LanguageSupport(xpathLanguage)
}
