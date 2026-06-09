import { formatRelativeDate } from "@/lib/utils/format";

/**
 * Wall-clock-relative text ("3m ago") for a fixed timestamp.
 *
 * The rendered string is a function of "now", so the server render and
 * the client's hydration pass legitimately disagree whenever the gap
 * between them crosses a unit boundary ("2m ago" → "3m ago"). React
 * treats that as a hydration text mismatch — it throws error #418 and
 * regenerates the whole tree on the client. `suppressHydrationWarning`
 * is React's escape hatch for exactly this one-text-node case: the
 * mismatch check is skipped and the server's string stands until the
 * next client render.
 *
 * Relative-time text a CLIENT component renders needs this treatment —
 * client trees are server-rendered, then re-computed during hydration,
 * which is where the two clocks can disagree. Render through this
 * component where `formatRelativeDate` fits, or put
 * `suppressHydrationWarning` on the text's own element where it
 * doesn't (see the API-key labels in settings). Server Components and
 * text that only mounts client-side never hydrate against a second
 * computation, so they may call `formatRelativeDate` directly.
 */
export function RelativeTime({
	date,
	className,
}: {
	date: Date;
	className?: string;
}) {
	return (
		<span suppressHydrationWarning className={className}>
			{formatRelativeDate(date)}
		</span>
	);
}
