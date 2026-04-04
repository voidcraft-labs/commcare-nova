import type { ComponentPropsWithoutRef } from "react"

/**
 * Shared prop type for all tiptap toolbar icon components.
 * Re-exported here so individual icon files don't each define it locally.
 */
export type TiptapIconProps = ComponentPropsWithoutRef<"svg">

/**
 * Base SVG wrapper for tiptap toolbar icons. Centralizes common attributes
 * (24×24, "0 0 24 24" viewBox, currentColor fill) and marks the SVG as
 * `aria-hidden` — these icons are always decorative, rendered inside labeled
 * buttons that carry their own accessible name via `aria-label`.
 *
 * Stroke-variant icons (image, table) override `fill` / `stroke` via props.
 */
export function TiptapSvg({ children, className, ...props }: TiptapIconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {children}
    </svg>
  )
}
