"use client";
import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerX from "@iconify-icons/tabler/x";
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
	/** Disable the preview (kept visible + hoverable, not removed), used while the
	 *  document is still reading, since the preview's extract can't load until
	 *  extraction finishes. The tooltip explains the wait. */
	previewDisabled?: boolean;
	/** Tooltip shown on the disabled preview body in place of the filename. */
	previewDisabledTooltip?: string;
	/** Renders a trailing × that removes the chip (composer only). */
	onRemove?: () => void;
	/** Disable the remove × (kept visible, not hidden): used while the document is
	 *  still reading, since extraction persists to the library regardless and a
	 *  working × would be a false "cancel". The tooltip explains the wait. */
	removeDisabled?: boolean;
	/** Tooltip shown on the disabled × in place of "Remove". */
	removeDisabledTooltip?: string;
	/** The document is still being read. The type glyph takes the active tint but
	 *  stays still; the composer's activity status is the one moving indicator
	 *  and the surface that narrates the wait. */
	reading?: boolean;
	/** Extraction failed: renders a compact rose retry between name and ×. The
	 *  one state that grows the chip, because a file Nova can't read would
	 *  otherwise fail silently. */
	onRetry?: () => void;
}

/**
 * One attachment chip: the shared presentational unit for both the composer's
 * pending-attachment bar and the transcript's per-message manifest. Kept dumb:
 * it knows how to show a file (glyph + name + actions), not where the data
 * comes from, so the composer (asset views) and the message (asset refs) both
 * feed it the same `{ kind, filename }`.
 *
 * The chip is deliberately COMPACT: its controls are 32px chip-local buttons,
 * not the 44px shadcn Button. Inside a small pill the standard control height
 * extends every hover/press bound past the visible chip, so three overlapping
 * halos float around a sliver of chrome. The chip clips its children
 * (`overflow-hidden`), each control fills the chip's own height, and focus
 * uses the inset ring so the clip can't crop it. This is the one sanctioned
 * exception to the 44px floor (see `components/CLAUDE.md`).
 *
 * The clickable body is a sibling of the retry/remove buttons, never their
 * parent: HTML forbids nesting interactive content inside a `<button>`, and an
 * SSR parser would mangle the tree.
 */
export function AttachmentChip({
	kind,
	filename,
	onPreview,
	previewDisabled,
	previewDisabledTooltip,
	onRemove,
	removeDisabled,
	removeDisabledTooltip,
	reading,
	onRetry,
}: AttachmentChipProps) {
	const meta = ASSET_KIND_META[kind];
	const label = (
		<>
			<Icon
				aria-hidden="true"
				icon={meta.icon}
				className={cn(
					"size-3.5 shrink-0",
					reading ? "text-nova-violet-bright" : "text-nova-text-muted",
				)}
			/>
			<span className="truncate">{filename}</span>
		</>
	);
	const bodyClass = "flex h-full min-w-0 items-center gap-1.5 px-2";

	return (
		<div className="inline-flex h-8 max-w-56 items-center overflow-hidden rounded-lg border border-nova-border bg-nova-surface text-xs text-nova-text-secondary">
			{onPreview ? (
				/* While the document is still reading, the preview body goes inert the
				 * same way the × does: `aria-disabled` (not native `disabled`) and no
				 * click handler, so it stays hoverable/focusable for the explanatory
				 * tooltip a truly-disabled button would suppress. */
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={previewDisabled ? undefined : onPreview}
								aria-disabled={previewDisabled || undefined}
								className={cn(
									"nova-focusable-inset",
									bodyClass,
									previewDisabled
										? "cursor-not-allowed"
										: "cursor-pointer transition-colors hover:bg-white/[0.06] hover:text-nova-text",
								)}
							>
								{label}
							</button>
						}
					/>
					<TooltipContent>
						{previewDisabled ? (previewDisabledTooltip ?? filename) : filename}
					</TooltipContent>
				</Tooltip>
			) : (
				<span className={bodyClass}>{label}</span>
			)}
			{onRetry && (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={onRetry}
								aria-label={`Nova couldn't read ${filename}. Try again`}
								className="nova-focusable-inset flex h-full w-7 shrink-0 cursor-pointer items-center justify-center text-nova-rose transition-colors hover:bg-white/[0.06]"
							>
								<Icon icon={tablerRefresh} className="size-3.5" />
							</button>
						}
					/>
					<TooltipContent>
						Nova couldn't read this file. Try again
					</TooltipContent>
				</Tooltip>
			)}
			{onRemove && (
				/* The × stays VISIBLE while disabled so the affordance doesn't flicker
				 * in/out as a doc finishes reading. `aria-disabled` (not the native
				 * `disabled` attribute) is deliberate: a truly-disabled button receives
				 * no pointer events, so its tooltip: the one thing explaining WHY it's
				 * disabled: would never open. We instead drop the click handler and
				 * style it inert, keeping it hoverable/focusable for the explanation. */
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={removeDisabled ? undefined : onRemove}
								aria-disabled={removeDisabled || undefined}
								aria-label={
									removeDisabled
										? `${filename} can't be removed while it's being read`
										: `Remove ${filename}`
								}
								className={cn(
									"nova-focusable-inset flex h-full w-7 shrink-0 items-center justify-center",
									removeDisabled
										? "cursor-not-allowed"
										: "cursor-pointer transition-colors hover:bg-white/[0.06] hover:text-nova-text",
								)}
							>
								<Icon icon={tablerX} className="size-3.5" />
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
