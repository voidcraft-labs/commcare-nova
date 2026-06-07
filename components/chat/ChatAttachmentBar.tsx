"use client";
import { PromptInputHeader } from "@/components/ai-elements/prompt-input";
import { ExtractionStatusBadgeView } from "@/components/builder/media/ExtractionStatusBadge";
import type {
	ExtractMeta,
	MediaAssetView,
} from "@/components/builder/media/mediaClient";
import { useDocumentExtraction } from "@/components/builder/media/useDocumentExtraction";
import { READ_ENERGY_PER_CHAR, signalGrid } from "@/lib/signalGrid/store";
import { AttachmentChip } from "./AttachmentChip";

/** Pulse the signal grid with real read progress as a doc streams in — so the grid
 *  shows tokens flowing, not an idle resting state, during the read. Module-level
 *  (only touches the signal-grid singleton) so it stays valid after the chip
 *  unmounts on send, while the build-scoped read keeps streaming. */
const feedGridEnergy = (chars: number): void =>
	signalGrid.injectThinkEnergy(chars * READ_ENERGY_PER_CHAR);

interface ChatAttachmentBarProps {
	/** The assets staged for the next send. */
	assets: MediaAssetView[];
	/** Remove a staged asset by id. */
	onRemove: (assetId: string) => void;
	/** Open the preview for an asset. */
	onPreview: (asset: MediaAssetView) => void;
	/** A staged document's extraction finished — reconcile its snapshot so the
	 *  chip preview (and the eventual send ref) carry the fresh title/summary. */
	onExtracted: (assetId: string, extract: ExtractMeta) => void;
	/** Build-scoped abort signal for the extraction reads (see `ChatInput`). Keeps a
	 *  read feeding the grid after its chip unmounts on send, until it completes. */
	extractionAbortSignal?: AbortSignal;
}

/**
 * One staged chip. Owns the asset's extraction lifecycle (the single
 * `useDocumentExtraction` call) so the chip can both render the status badge AND
 * gate its own remove control on that status — the hook can't be called inside
 * the parent's `.map`, and a second call (one here, one in the badge) would
 * double-trigger extraction.
 */
function StagedChip({
	asset,
	onRemove,
	onPreview,
	onExtracted,
	extractionAbortSignal,
}: {
	asset: MediaAssetView;
	onRemove: (assetId: string) => void;
	onPreview: (asset: MediaAssetView) => void;
	onExtracted: (assetId: string, extract: ExtractMeta) => void;
	extractionAbortSignal?: AbortSignal;
}) {
	const { status, retry } = useDocumentExtraction(
		asset,
		(extract) => onExtracted(asset.id, extract),
		feedGridEnergy,
		// Build-scoped, NOT chip-scoped: the read must keep feeding the grid after
		// this chip unmounts on send, until extraction finishes.
		extractionAbortSignal,
	);
	// A reading document persists to the library regardless of removal, so the ×
	// is disabled (not a real "cancel") until extraction settles. ready / failed /
	// non-document chips remove freely.
	const reading = status === "extracting";
	return (
		<AttachmentChip
			kind={asset.kind}
			filename={asset.displayName ?? asset.originalFilename}
			onPreview={() => onPreview(asset)}
			onRemove={() => onRemove(asset.id)}
			removeDisabled={reading}
			removeDisabledTooltip="Still reading this in — you can remove it once it's done."
			trailing={<ExtractionStatusBadgeView status={status} retry={retry} />}
		/>
	);
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
	onExtracted,
	extractionAbortSignal,
}: ChatAttachmentBarProps) {
	if (assets.length === 0) return null;
	// Render through PromptInputHeader (the InputGroup's block-start addon slot):
	// it lands the chip row ABOVE the textarea, full-width + left-aligned, with
	// the right padding. A bare div would fall into the InputGroup's centered
	// inline flow instead. Returns null when empty so no empty gutter shows.
	return (
		<PromptInputHeader className="gap-1.5">
			{assets.map((asset) => (
				<StagedChip
					key={asset.id}
					asset={asset}
					onRemove={onRemove}
					onPreview={onPreview}
					onExtracted={onExtracted}
					extractionAbortSignal={extractionAbortSignal}
				/>
			))}
		</PromptInputHeader>
	);
}
