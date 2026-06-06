"use client";
import { PromptInputHeader } from "@/components/ai-elements/prompt-input";
import { ExtractionStatusBadge } from "@/components/builder/media/ExtractionStatusBadge";
import type { MediaAssetView } from "@/components/builder/media/mediaClient";
import { AttachmentChip } from "./AttachmentChip";

interface ChatAttachmentBarProps {
	/** The assets staged for the next send. */
	assets: MediaAssetView[];
	/** Remove a staged asset by id. */
	onRemove: (assetId: string) => void;
	/** Open the preview for an asset. */
	onPreview: (asset: MediaAssetView) => void;
}

/**
 * The pending-attachment row above the composer textarea — the assets the user
 * has picked from the file manager for the next turn. Renders nothing when
 * empty so the composer doesn't carry a blank gutter. Each chip can be previewed
 * or removed before sending.
 */
export function ChatAttachmentBar({
	assets,
	onRemove,
	onPreview,
}: ChatAttachmentBarProps) {
	if (assets.length === 0) return null;
	// Render through PromptInputHeader (the InputGroup's block-start addon slot):
	// it lands the chip row ABOVE the textarea, full-width + left-aligned, with
	// the right padding. A bare div would fall into the InputGroup's centered
	// inline flow instead. Returns null when empty so no empty gutter shows.
	return (
		<PromptInputHeader className="gap-1.5">
			{assets.map((asset) => (
				<AttachmentChip
					key={asset.id}
					kind={asset.kind}
					filename={asset.displayName ?? asset.originalFilename}
					onPreview={() => onPreview(asset)}
					onRemove={() => onRemove(asset.id)}
					trailing={<ExtractionStatusBadge asset={asset} />}
				/>
			))}
		</PromptInputHeader>
	);
}
