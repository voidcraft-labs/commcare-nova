import { Icon, type IconifyIcon } from "@iconify/react/offline";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Shared prop type for all tiptap toolbar icon components.
 * Re-exported here so individual icon files don't each define it locally.
 */
export type TiptapIconProps = ComponentPropsWithoutRef<"svg">;

/**
 * Renders a Tabler icon via Iconify's offline renderer. Passes through
 * `className` for styling and marks the SVG as `aria-hidden` — these icons
 * are always decorative, rendered inside labeled buttons that carry their
 * own accessible name via `aria-label`.
 */
export function TiptapIcon({
	icon,
	className,
}: {
	icon: IconifyIcon;
	className?: string;
}) {
	return <Icon icon={icon} width="24" height="24" className={className} />;
}
