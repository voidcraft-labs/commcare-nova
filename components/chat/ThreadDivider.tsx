/**
 * ThreadDivider — visual separator between historical threads and the
 * active conversation area in the chat sidebar.
 *
 * Renders a thin horizontal rule with generous vertical spacing. The
 * divider communicates an unmistakable boundary: everything above is
 * dead history, everything below is the live session.
 */

export function ThreadDivider() {
	return (
		<div className="my-3 flex items-center gap-3 px-2">
			<div className="h-px flex-1 bg-nova-border" />
			<span className="shrink-0 text-[10px] font-medium tracking-wide text-nova-text-muted/60 uppercase">
				Now
			</span>
			<div className="h-px flex-1 bg-nova-border" />
		</div>
	);
}
