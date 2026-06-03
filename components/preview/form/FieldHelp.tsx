"use client";

import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import type { Media } from "@/lib/domain/multimedia";
import { PreviewMarkdown } from "@/lib/markdown";

/**
 * A field's help text + help media. CommCare hides help behind a "?" disclosure
 * on device; Nova's builder preview renders it inline and muted so the author
 * can see what help they've set (the preview's job is to show the authored
 * content, not reproduce the runtime affordance).
 *
 * Rendered identically in edit and live — only `interactive` differs (toggling
 * the media's `pointer-events`) — so a field with help is the same height in
 * both modes and the edit↔preview flipbook holds. Help text is NOT inline-
 * editable in the form (it's edited in the field panel), so it needs no
 * `TextEditable`/parity wrapper. Returns `null` when the field has neither, so
 * a caller can mount it unconditionally.
 */
export function FieldHelp({
	help,
	helpMedia,
	interactive,
}: {
	help: string | undefined;
	helpMedia: Media | undefined;
	interactive: boolean;
}) {
	if (!help && !helpMedia) return null;
	return (
		<div className="space-y-1.5">
			{help && (
				<div className="preview-markdown text-xs text-nova-text-muted/80">
					<PreviewMarkdown>{help}</PreviewMarkdown>
				</div>
			)}
			<MediaDisplay media={helpMedia} interactive={interactive} />
		</div>
	);
}
