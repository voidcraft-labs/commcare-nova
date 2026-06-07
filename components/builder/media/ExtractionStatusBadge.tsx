// components/builder/media/ExtractionStatusBadge.tsx
//
// The feature-extraction indicator shown on a document in the file manager and
// the composer: "Reading…" while the extract is being produced, "Extracted" once
// Nova can read it, "Couldn't read" (with retry) on failure. Nothing for a
// non-document (images reach the model directly). This is the surface that
// answers "is feature extraction happening?" — so a user understands Nova works
// from the extract, not the raw file.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import { Badge } from "@/components/shadcn/badge";
import { Spinner } from "@/components/shadcn/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import type { MediaExtractStatus } from "@/lib/domain/multimedia";
import { ExtractionInfoPopover } from "./ExtractionInfoPopover";
import type { ExtractMeta } from "./mediaClient";
import {
	type ExtractableAsset,
	useDocumentExtraction,
} from "./useDocumentExtraction";

/**
 * Hook-driving wrapper: kicks off (and tracks) extraction for `asset`, then
 * renders the indicator. Used where the badge is the sole consumer of the
 * extraction status (the file manager). The composer drives the hook itself —
 * it also needs the status to gate the chip's remove control — and renders
 * `ExtractionStatusBadgeView` directly with the result.
 */
export function ExtractionStatusBadge({
	asset,
	onExtracted,
}: {
	asset: ExtractableAsset;
	/** Forwarded to `useDocumentExtraction`: fires with the fresh metadata when
	 *  extraction completes, so a staged snapshot (composer / library) reconciles. */
	onExtracted?: (extract: ExtractMeta) => void;
}) {
	const { status, retry } = useDocumentExtraction(asset, onExtracted);
	return <ExtractionStatusBadgeView status={status} retry={retry} />;
}

/**
 * Presentational indicator: "Reading…" / "Couldn't read" (retry) / "Extracted",
 * or nothing for a non-document. Split from the hook so a caller that already
 * holds the extraction status (the composer, which gates the chip's X on it) can
 * render the same badge without triggering a second `useDocumentExtraction`.
 */
export function ExtractionStatusBadgeView({
	status,
	retry,
}: {
	status: MediaExtractStatus | null;
	retry: () => void;
}) {
	if (status === null) return null;

	if (status === "extracting") {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<Badge variant="secondary">
							<Spinner className="size-3" />
							Reading…
						</Badge>
					}
				/>
				<TooltipContent>
					Reading this into Nova's extract — this can take up to a minute.
				</TooltipContent>
			</Tooltip>
		);
	}

	if (status === "failed") {
		// Render the badge as a button so a failed extract is one click to retry.
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<Badge
							variant="destructive"
							render={
								<button type="button" onClick={retry}>
									<Icon icon={tablerAlertTriangle} />
									Retry
								</button>
							}
						/>
					}
				/>
				<TooltipContent>Couldn't read this — click to retry</TooltipContent>
			</Tooltip>
		);
	}

	// ready — the clickable info popover takes the decorative sparkles' place
	// (sized to the badge's icon so the chip doesn't widen) and explains what Nova
	// reads on click; no hover tooltip, the one affordance is enough.
	return (
		<Badge variant="outline">
			<ExtractionInfoPopover className="size-3" />
			Extracted
		</Badge>
	);
}
