/**
 * Convert Confluence storage format (HTML-ish XML) to clean text.
 * Good enough for LLM consumption — not a perfect HTML→Markdown converter.
 */

export function cleanStorageFormat(html: string): string {
  if (!html) return ''

  let text = html

  // 1. Extract code blocks from Confluence code macros, replace with placeholders
  const codeBlocks: string[] = []
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>\s*<\/ac:structured-macro>/gi,
    (_, code) => {
      codeBlocks.push(code)
      return `\n\`\`\`\n__CODE_BLOCK_${codeBlocks.length - 1}__\n\`\`\`\n`
    }
  )

  // 2. Handle info/note/warning/tip panels — extract content
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name="(info|note|warning|tip|expand)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, type, inner) => {
      // Extract rich-text-body content
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i)
      const body = bodyMatch ? bodyMatch[1] : ''
      return `\n**${type.toUpperCase()}**: ${body}\n`
    }
  )

  // 3. Remove all remaining ac:structured-macro blocks (toc, jira, etc.)
  text = text.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/gi, '')
  // Self-closing macros
  text = text.replace(/<ac:structured-macro[^>]*\/>/gi, '')

  // 4. Unwrap layout containers — keep inner content
  text = text.replace(/<\/?ac:layout(?:-section|-cell)?[^>]*>/gi, '')

  // 5. Remove ac:emoticon, ac:image, ac:inline-comment, ri:* tags
  text = text.replace(/<ac:emoticon[^>]*\/>/gi, '')
  text = text.replace(/<ac:image[^>]*>[\s\S]*?<\/ac:image>/gi, '')
  text = text.replace(/<ac:image[^>]*\/>/gi, '')
  text = text.replace(/<ac:inline-comment-marker[^>]*>([\s\S]*?)<\/ac:inline-comment-marker>/gi, '$1')
  text = text.replace(/<ri:[^>]*\/>/gi, '')
  text = text.replace(/<ri:[^>]*>[\s\S]*?<\/ri:[^>]*>/gi, '')

  // 6. Handle ac:link — extract link text
  text = text.replace(/<ac:link[^>]*>[\s\S]*?<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>[\s\S]*?<\/ac:link>/gi, '$1')
  text = text.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi, '$1')

  // 7. Remove any remaining ac:* tags
  text = text.replace(/<\/?ac:[^>]*>/gi, '')

  // 8. Convert HTML headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')

  // 9. Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
  text = text.replace(/<\/?[uo]l[^>]*>/gi, '\n')

  // 10. Convert table cells
  text = text.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, ' | $1')
  text = text.replace(/<tr[^>]*>/gi, '\n')
  text = text.replace(/<\/?tr[^>]*>/gi, '')
  text = text.replace(/<\/?t(?:able|head|body|foot)[^>]*>/gi, '\n')

  // 11. Convert inline elements
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')

  // 12. Paragraphs and breaks
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
  text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n')
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')

  // 13. Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // 14. Decode HTML entities
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))

  // 15. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i])
  }

  // 16. Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ')       // Collapse horizontal whitespace
  text = text.replace(/\n{3,}/g, '\n\n')    // Max 2 consecutive newlines
  text = text.replace(/^\s+|\s+$/g, '')      // Trim
  text = text.split('\n').map(l => l.trim()).join('\n') // Trim each line

  return text
}
