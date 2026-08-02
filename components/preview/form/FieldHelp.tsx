"use client";

import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import type { ProseTemplate } from "@/lib/domain";
import type { Media } from "@/lib/domain/multimedia";
import { LabelContent } from "@/lib/references/LabelContent";

/**
 * A field's help text + help media. CommCare hides help behind a "?" disclosure
 * on device; Nova's builder preview renders it inline and muted so the author
 * can see what help they've set (the preview's job is to show the authored
 * content, not reproduce the runtime affordance).
 *
 * Rendered identically in edit and live: only `interactive` differs (toggling
 * the media's `pointer-events`), so a field with help is the same height in
 * both modes and the edit↔preview flipbook holds. Help text is NOT inline-
 * editable in the form (it's edited in the field panel), so it needs no
 * `TextEditable`/parity wrapper. Returns `null` when the field has neither, so
 * a caller can mount it unconditionally.
 */
export function FieldHelp({
	id,
	help,
	resolvedHelp,
	helpMedia,
	interactive,
}: {
	id?: string;
	help: ProseTemplate | undefined;
	resolvedHelp?: string;
	helpMedia: Media | undefined;
	interactive: boolean;
}) {
	if (!help && !helpMedia) return null;
	return (
		<div id={id} className="space-y-1.5">
			{help && (
				<LabelContent
					label={help}
					resolvedLabel={resolvedHelp}
					isEditMode={!interactive}
					className="text-xs text-nova-text-muted"
				/>
			)}
			<MediaDisplay media={helpMedia} interactive={interactive} />
		</div>
	);
}
