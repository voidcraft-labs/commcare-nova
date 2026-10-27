"use client";

import { Icon } from "@iconify/react/offline";
import { cn } from "@/lib/utils";
import { ASSET_KIND_META } from "./assetKindMeta";

/**
 * The line Preview shows in a player's place for an audio or video file only
 * Android plays (`lib/media/platformPlayback.ts::browserStandIn`): Preview
 * plays media in the browser, which plays what Web Apps plays. The line is a
 * fact of the file, the same on either platform Preview runs as.
 */
export function MediaStandIn({
	kind,
	line,
	className,
}: {
	kind: "audio" | "video";
	line: string;
	className?: string;
}) {
	return (
		<p
			className={cn(
				"flex max-w-full items-center gap-2 rounded-md border border-dashed border-nova-border px-3 py-2 text-sm text-nova-text-secondary",
				className,
			)}
		>
			<Icon
				icon={ASSET_KIND_META[kind].icon}
				className="size-4 shrink-0 text-nova-text-muted"
			/>
			<span className="min-w-0">{line}</span>
		</p>
	);
}
