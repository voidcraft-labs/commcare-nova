import { memo } from "react"
import { TiptapSvg, type TiptapIconProps } from "./TiptapSvg"

/** Image insert icon. */
export const ImageIcon = memo((props: TiptapIconProps) => (
  <TiptapSvg
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </TiptapSvg>
))

ImageIcon.displayName = "ImageIcon"
