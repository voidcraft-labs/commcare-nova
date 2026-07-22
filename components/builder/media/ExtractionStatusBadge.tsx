// components/builder/media/ExtractionStatusBadge.tsx
//
// The feature-extraction indicator shown on a document in the file manager and
// the composer: "Reading…" while the file is being prepared, "Ready" once
// Nova can read it, "Couldn't read" (with retry) on failure. Nothing for a
// non-document (images reach the model directly). This is the surface that
// answers "is feature extraction happening?" — so a user understands Nova works
// from the extract, not the raw file.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import {
	SimpleTooltip,
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
	canExtract = true,
}: {
	asset: ExtractableAsset;
	/** Forwarded to `useDocumentExtraction`: fires with the fresh metadata when
	 *  extraction completes, so a staged snapshot (composer / library) reconciles. */
	onExtracted?: (extract: ExtractMeta) => void;
	/** Viewers may inspect an existing extract but never start/retry the
	 *  Project-scoped extraction write. */
	canExtract?: boolean;
}) {
	const { status, retry } = useDocumentExtraction(
		asset,
		onExtracted,
		undefined,
		undefined,
		canExtract,
	);
	return (
		<ExtractionStatusBadgeView
			status={status}
			retry={retry}
			canRetry={canExtract}
		/>
	);
}

/**
 * Presentational indicator: "Reading…" / "Couldn't read" (retry) / "Ready",
 * or nothing for a non-document. Split from the hook so a caller that already
 * holds the extraction status (the composer, which gates the chip's X on it) can
 * render the same badge without triggering a second `useDocumentExtraction`.
 */
export function ExtractionStatusBadgeView({
	status,
	retry,
	canRetry = true,
}: {
	status: MediaExtractStatus | null;
	retry: () => void;
	canRetry?: boolean;
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
					Nova is reading this file. This can take a few minutes.
				</TooltipContent>
			</Tooltip>
		);
	}

	if (status === "failed") {
		if (!canRetry) {
			return (
				<Badge variant="destructive" className="min-h-11 gap-1.5 px-3">
					<Icon icon={tablerAlertTriangle} />
					Couldn't read
				</Badge>
			);
		}
		// A failed extract is one clear, full-size action rather than a tiny badge
		// that happens to be clickable.
		return (
			<SimpleTooltip content="Try reading this file again">
				<Button
					type="button"
					variant="destructive"
					className="h-11 px-3"
					onClick={retry}
				>
					<Icon icon={tablerAlertTriangle} />
					Retry
				</Button>
			</SimpleTooltip>
		);
	}

	// Ready keeps the status and its explanation together. The info trigger gets
	// the same full-size target as the other media controls.
	return (
		<Badge variant="outline" className="min-h-11 gap-1.5 px-2 text-xs">
			<ExtractionInfoPopover />
			Ready
		</Badge>
	);
}
