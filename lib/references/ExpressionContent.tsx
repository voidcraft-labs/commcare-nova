/**
 * Renders an XPath expression with hashtag references (#form/path, #case/path,
 * #user/path) as dimmed inline ReferenceChip components. Plain expression text
 * is rendered as-is. Used by HiddenField for calculate/default_value display.
 */

'use client'
import { ReferenceChip } from './ReferenceChip'
import { useReferenceProvider } from './ReferenceContext'
import { parseLabelSegments, resolveRefFromExpr } from './renderLabel'

interface ExpressionContentProps {
  expr: string
}

export function ExpressionContent({ expr }: ExpressionContentProps) {
  const provider = useReferenceProvider()
  const segments = parseLabelSegments(expr)

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.text}</span>

        const ref = resolveRefFromExpr(seg.value, provider)
        if (!ref) return <span key={i}>{seg.value}</span>

        return <span key={i} className="opacity-50"><ReferenceChip reference={ref} /></span>
      })}
    </>
  )
}
