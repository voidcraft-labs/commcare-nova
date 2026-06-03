"use client";
import { useState } from "react";
import {
	AssetPreviewDialog,
	type AssetPreviewTarget,
} from "@/components/builder/media/AssetPreviewDialog";
import type { AttachmentRef } from "@/lib/chat/attachmentRefs";
import { AttachmentChip } from "./AttachmentChip";

/**
 * The attachment manifest shown on a message in the transcript — one chip per
 * file the user attached, each opening the preview ("Document" + "What the AI
 * reads"). Reads the refs off the message's metadata, so the same render path
 * serves a live turn, a replayed turn, and a loaded thread (all populate
 * `metadata.attachments` with the one `AttachmentRef` shape). Owns its own
 * preview dialog so a message is self-contained.
 */
export function MessageAttachments({
	attachments,
}: {
	attachments: AttachmentRef[];
}) {
	const [target, setTarget] = useState<AssetPreviewTarget | null>(null);
	if (attachments.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{attachments.map((ref) => (
				<AttachmentChip
					key={ref.assetId}
					kind={ref.kind}
					filename={ref.filename}
					onPreview={() =>
						setTarget({
							id: ref.assetId,
							kind: ref.kind,
							filename: ref.filename,
						})
					}
				/>
			))}
			<AssetPreviewDialog
				target={target}
				onOpenChange={(open) => {
					if (!open) setTarget(null);
				}}
			/>
		</div>
	);
}
