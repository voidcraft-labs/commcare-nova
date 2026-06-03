"use client";

import type { Media } from "@/lib/domain/multimedia";
import { cn } from "@/lib/utils";
import { mediaSrc } from "./mediaClient";

/**
 * The READ surface for a carrier's attached media — what the form/menu/app
 * actually shows, the way CommCare renders media alongside a question: the
 * image above the label, an audio player, a video player. `MediaSlot` is the
 * authoring surface (attach / replace / remove); this is its display twin.
 *
 * Edit and preview render the IDENTICAL elements — `interactive` only toggles
 * `pointer-events-none` — so a field's row is the same height in both modes
 * and the edit↔preview flipbook never drifts (the parity invariant the form
 * renderers uphold). In edit mode the block is `pointer-events-none`: the
 * field wrapper is a `div[role=button]` whose click selects the field, and a
 * live `<audio controls>` would otherwise swallow that click (or play on a
 * mis-click); disabling pointer events lets the select reach the field while
 * the player still shows the viewer what's attached. In preview mode the
 * controls are live.
 *
 * Returns `null` for an empty bundle, so a caller can mount it unconditionally
 * above a label without its own presence check.
 */
export function MediaDisplay({
	media,
	interactive,
	className,
	imageClassName = "max-h-40 max-w-full rounded-md object-contain",
}: {
	media: Media | undefined;
	interactive: boolean;
	className?: string;
	/** Override the image's size box — compact contexts (a select option,
	 *  a dense list) pass a smaller cap than the default label size. */
	imageClassName?: string;
}) {
	if (!media || (!media.image && !media.audio && !media.video)) return null;
	return (
		<div
			className={cn(
				"flex flex-col items-start gap-1.5",
				!interactive && "pointer-events-none",
				className,
			)}
		>
			{media.image && (
				// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
				<img src={mediaSrc(media.image)} alt="" className={imageClassName} />
			)}
			{media.audio && (
				// Definite width — a native `<audio>` has no intrinsic width and
				// `w-full` collapses to 0 inside an `items-start` flex column (the
				// same trap MediaSlot's preview hit).
				// biome-ignore lint/a11y/useMediaCaption: author-supplied media; no caption track available
				<audio
					src={mediaSrc(media.audio)}
					controls
					className="w-72 max-w-full"
				/>
			)}
			{media.video && (
				// biome-ignore lint/a11y/useMediaCaption: author-supplied media; no caption track available
				<video
					src={mediaSrc(media.video)}
					controls
					className="max-h-40 max-w-full rounded-md"
				/>
			)}
		</div>
	);
}
