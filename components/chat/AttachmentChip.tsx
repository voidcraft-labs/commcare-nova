"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import type { ReactNode } from "react";
import { ASSET_KIND_META } from "@/components/builder/media/assetKindMeta";
import type { AssetKind } from "@/lib/domain/multimedia";
import { cn } from "@/lib/utils";

interface AttachmentChipProps {
	/** Drives the leading file-type glyph (PDF / DOCX / image / …). */
	kind: AssetKind;
	/** The display filename, truncated with an ellipsis when long. */
	filename: string;
	/** Opens the preview. When set, the chip body is a button (keyboard-reachable). */
	onPreview?: () => void;
	/** Renders a trailing × that removes the chip (composer only). */
	onRemove?: () => void;
	/** Trailing status slot — the extraction indicator badge. */
	trailing?: ReactNode;
}

/**
 * One attachment chip — the shared presentational unit for both the composer's
 * pending-attachment bar and the transcript's per-message manifest. Kept dumb:
 * it knows how to show a file (glyph + name + optional status + actions), not
 * where the data comes from, so the composer (asset views) and the message
 * (asset refs) both feed it the same `{ kind, filename }`.
 *
 * The clickable body is a sibling of the remove button, never its parent — HTML
 * forbids nesting interactive content inside a `<button>`, and an SSR parser
 * would mangle the tree.
 */
export function AttachmentChip({
	kind,
	filename,
	onPreview,
	onRemove,
	trailing,
}: AttachmentChipProps) {
	const meta = ASSET_KIND_META[kind];
	// Only the glyph + filename go inside the preview button. `trailing` (the
	// extraction badge — which can itself be a Retry BUTTON on failure) and the
	// remove button are SIBLINGS of it: HTML forbids interactive content nested
	// inside a `<button>`, and nesting would also bubble a Retry/remove click
	// through to the preview handler.
	const label = (
		<>
			<Icon
				icon={meta.icon}
				className="size-3.5 shrink-0 text-nova-text-muted"
			/>
			<span className="truncate">{filename}</span>
		</>
	);

	return (
		<div className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border border-nova-border bg-nova-surface py-1 pr-1 pl-2 text-xs text-nova-text-secondary">
			{onPreview ? (
				<button
					type="button"
					onClick={onPreview}
					title={`Preview ${filename}`}
					className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm transition-colors hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
				>
					{label}
				</button>
			) : (
				<span className="flex min-w-0 items-center gap-1.5">{label}</span>
			)}
			{trailing}
			{onRemove && (
				<button
					type="button"
					onClick={onRemove}
					title={`Remove ${filename}`}
					className={cn(
						"flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm",
						"text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text",
						"focus-visible:outline-1 focus-visible:outline-nova-violet-bright",
					)}
					aria-label={`Remove ${filename}`}
				>
					<Icon icon={tablerX} className="size-3" />
				</button>
			)}
		</div>
	);
}
