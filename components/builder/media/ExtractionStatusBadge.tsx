// components/builder/media/ExtractionStatusBadge.tsx
//
// The feature-extraction indicator shown on a document in the file manager and
// the composer: "Reading…" while the extract is being produced, "Extracted" once
// the assistant can read it, "Couldn't read" (with retry) on failure. Nothing
// for a non-document (images reach the model directly). This is the surface that
// answers "is feature extraction happening?" — so a user understands the
// assistant works from the extract, not the raw file.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { Badge } from "@/components/shadcn/badge";
import { Spinner } from "@/components/shadcn/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import {
	type ExtractableAsset,
	useDocumentExtraction,
} from "./useDocumentExtraction";

export function ExtractionStatusBadge({ asset }: { asset: ExtractableAsset }) {
	const { status, retry } = useDocumentExtraction(asset);

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
					Reading this into the assistant's extract…
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

	// ready
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Badge variant="outline">
						<Icon icon={tablerSparkles} />
						Extracted
					</Badge>
				}
			/>
			<TooltipContent>Read into the assistant's extract</TooltipContent>
		</Tooltip>
	);
}
