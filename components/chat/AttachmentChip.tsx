"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import type { ReactNode } from "react";
import { ASSET_KIND_META } from "@/components/builder/media/assetKindMeta";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
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
	/** Disable the remove × (kept visible, not hidden) — used while the document is
	 *  still reading, since extraction persists to the library regardless and a
	 *  working × would be a false "cancel". The tooltip explains the wait. */
	removeDisabled?: boolean;
	/** Tooltip shown on the disabled × in place of "Remove". */
	removeDisabledTooltip?: string;
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
	removeDisabled,
	removeDisabledTooltip,
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
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={onPreview}
								className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm transition-colors hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
							>
								{label}
							</button>
						}
					/>
					<TooltipContent>{filename}</TooltipContent>
				</Tooltip>
			) : (
				<span className="flex min-w-0 items-center gap-1.5">{label}</span>
			)}
			{trailing}
			{onRemove && (
				/* The × stays VISIBLE while disabled so the affordance doesn't flicker
				 * in/out as a doc finishes reading. `aria-disabled` (not the native
				 * `disabled` attribute) is deliberate: a truly-disabled button receives
				 * no pointer events, so its tooltip — the one thing explaining WHY it's
				 * disabled — would never open. We instead drop the click handler and
				 * style it inert, keeping it hoverable/focusable for the explanation. */
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={removeDisabled ? undefined : onRemove}
								aria-disabled={removeDisabled || undefined}
								className={cn(
									"flex size-4 shrink-0 items-center justify-center rounded-sm",
									"focus-visible:outline-1 focus-visible:outline-nova-violet-bright",
									removeDisabled
										? "cursor-default text-nova-text-muted/40"
										: "cursor-pointer text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text",
								)}
								aria-label={
									removeDisabled
										? `${filename} can't be removed while it's being read`
										: `Remove ${filename}`
								}
							>
								<Icon icon={tablerX} className="size-3" />
							</button>
						}
					/>
					<TooltipContent>
						{removeDisabled ? (removeDisabledTooltip ?? "Remove") : "Remove"}
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}
