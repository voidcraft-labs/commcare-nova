import { createTheme } from '@uiw/codemirror-themes'
import { tags as t } from '@lezer/highlight'

/** Dark CodeMirror theme matching the Nova design system. */
export const novaXPathTheme = createTheme({
  theme: 'dark',
  settings: {
    background: 'transparent',
    foreground: '#8888aa',
    caret: '#a78bfa',
    selection: 'rgba(139, 92, 246, 0.2)',
    selectionMatch: 'rgba(139, 92, 246, 0.1)',
    lineHighlight: 'transparent',
    gutterBackground: 'transparent',
    gutterForeground: 'transparent',
    gutterBorder: 'transparent',
    fontFamily: 'var(--font-nova-mono)',
  },
  styles: [
    // CommCare hashtag refs (#case/prop, #form/question)
    { tag: t.special(t.variableName), color: '#22d3ee' },
    // $variable references
    { tag: t.variableName, color: '#a78bfa' },
    // Path segment names (data, items, question)
    { tag: t.propertyName, color: '#e8e8ff' },
    { tag: t.special(t.propertyName), color: '#e8e8ff' },
    // Functions
    { tag: t.function(t.variableName), color: '#10b981' },
    // Strings
    { tag: t.string, color: '#f59e0b' },
    // Numbers
    { tag: t.number, color: '#f59e0b' },
    // Keywords (and, or, div, mod, axis names, ., ..)
    { tag: t.keyword, color: '#c084fc' },
    // Operators (+, -, =, !=, etc.)
    { tag: t.operator, color: '#8888aa' },
    // Path separators (/, //, ,)
    { tag: t.separator, color: '#6366f1' },
    // Brackets [ ]
    { tag: t.squareBracket, color: '#c084fc' },
    // Parens ( )
    { tag: t.paren, color: '#f472b6' },
    // Axis/attribute markers (::, @)
    { tag: t.meta, color: '#6366f1' },
  ],
})
