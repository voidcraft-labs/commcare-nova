"use client";

import { type Media, mediaFormatPlaysOn } from "@/lib/domain/multimedia";
import { browserStandIn } from "@/lib/media/platformPlayback";
import type { AssetMetaRow } from "@/lib/session/provider";
import { cn } from "@/lib/utils";
import { MediaStandIn } from "./MediaStandIn";
import {
	ProjectMediaAudio,
	ProjectMediaImage,
	ProjectMediaVideo,
} from "./ProjectMediaResource";
import { useReferencedAssetRows } from "./useReferencedAssetRows";

/**
 * How an audio or video slot shows its file: its stand-in line where only
 * Android plays it, a player without a source while its row is unknown (so
 * no bytes are asked for before the row says whether the browser plays the
 * file), and the player otherwise.
 */
function playback(
	kind: "audio" | "video",
	row: AssetMetaRow | null | undefined,
):
	| { readonly kind: "stand-in"; readonly line: string }
	| { readonly kind: "pending" | "play" } {
	if (row === undefined) return { kind: "pending" };
	if (row === null || row.mediaFormat === undefined) return { kind: "play" };
	const line = browserStandIn({
		kind,
		playsOn: mediaFormatPlaysOn(row.mediaFormat),
	});
	return line === null ? { kind: "play" } : { kind: "stand-in", line };
}

/**
 * The READ surface for a carrier's attached media: what the form/menu/app
 * actually shows, the way CommCare renders media alongside a question: the
 * image above the label, an audio player, a video player. `MediaSlot` is the
 * authoring surface (attach / replace / remove); this is its display twin.
 *
 * Edit and preview render the IDENTICAL elements: `interactive` only toggles
 * `pointer-events-none`, so a field's row is the same height in both modes
 * and the edit↔preview flipbook never drifts (the parity invariant the form
 * renderers uphold). In edit mode the block is `pointer-events-none`: the
 * field wrapper is a `div[role=button]` whose click selects the field, and a
 * live `<audio controls>` would otherwise swallow that click (or play on a
 * mis-click); disabling pointer events lets the select reach the field while
 * the player still shows the viewer what's attached. In preview mode the
 * controls are live.
 *
 * Preview plays media in the browser, so it plays what Web Apps plays: an
 * audio or video file only Android plays shows its stand-in line in the
 * player's place (`MediaStandIn`).
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
	/** Override the image's size box: compact contexts (a select option,
	 *  a dense list) pass a smaller cap than the default label size. */
	imageClassName?: string;
}) {
	const rows = useReferencedAssetRows(
		[media?.audio, media?.video].filter(
			(id): id is NonNullable<typeof id> => id !== undefined,
		),
	);
	if (!media || (!media.image && !media.audio && !media.video)) return null;
	const audio = media.audio && playback("audio", rows[media.audio]);
	const video = media.video && playback("video", rows[media.video]);
	return (
		<div
			className={cn(
				"flex flex-col items-start gap-1.5",
				!interactive && "pointer-events-none",
				className,
			)}
		>
			{media.image && (
				<ProjectMediaImage
					assetId={media.image}
					alt=""
					className={imageClassName}
				/>
			)}
			{media.audio &&
				audio &&
				(audio.kind === "stand-in" ? (
					<MediaStandIn kind="audio" line={audio.line} />
				) : audio.kind === "pending" ? (
					// biome-ignore lint/a11y/useMediaCaption: a player with no source yet holds no speech to caption
					<audio controls className="w-72 max-w-full" />
				) : (
					// Definite width: a native `<audio>` has no intrinsic width and
					// `w-full` collapses to 0 inside an `items-start` flex column (the
					// same `w-full`-collapse MediaSlot's audio preview guards against).
					<ProjectMediaAudio
						assetId={media.audio}
						controls
						className="w-72 max-w-full"
					/>
				))}
			{media.video &&
				video &&
				(video.kind === "stand-in" ? (
					<MediaStandIn kind="video" line={video.line} />
				) : video.kind === "pending" ? (
					// biome-ignore lint/a11y/useMediaCaption: a player with no source yet holds no speech to caption
					<video controls className="max-h-40 max-w-full rounded-md" />
				) : (
					<ProjectMediaVideo
						assetId={media.video}
						controls
						className="max-h-40 max-w-full rounded-md"
					/>
				))}
		</div>
	);
}
