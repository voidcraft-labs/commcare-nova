"use client";
import { motion } from "motion/react";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import type { Media } from "@/lib/domain/multimedia";
import { PreviewMarkdown } from "@/lib/markdown";

/**
 * The validation message shown when a field is invalid. `media` is the field's
 * `validate_msg_media` — CommCare lets the validation message carry its own
 * image/audio/video, shown alongside the message text. The error only renders
 * in preview (edit mode is frozen and never touches a field), so the media is
 * interactive.
 */
export function ValidationError({
	message,
	media,
}: {
	message: string;
	media?: Media;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, y: -4 }}
			animate={{ opacity: 1, y: 0 }}
			className="preview-markdown text-xs text-nova-rose mt-1"
		>
			<PreviewMarkdown>{message}</PreviewMarkdown>
			<MediaDisplay media={media} interactive />
		</motion.div>
	);
}
