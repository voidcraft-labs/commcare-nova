// components/builder/media/MediaSlot.tsx
//
// The media-attach affordances every carrier mounts:
//
//  - `MediaSlot` — the `Media` bundle (image / audio / video, each
//    independent). Renders one row per requested kind: an empty kind
//    shows a "+ Image/Audio/Video" pill; a filled kind shows the
//    asset chip with a preview-on-click popover + replace/remove.
//  - `SingleAssetSlot` — one `AssetId` of a fixed kind (module icon,
//    case-list icon, app logo). Same chip, single slot.
//
// Both speak only ids to their carrier; the picker resolves bytes +
// metadata. The preview popover is colocated here (it's an
// implementation detail of the chip, not a standalone surface).

"use client";

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerReplace from "@iconify-icons/tabler/replace";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useState } from "react";
import type { Media, MediaKind } from "@/lib/domain/multimedia";
import {
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
} from "@/lib/styles";
import { MediaPickerDialog } from "./MediaPickerDialog";
import type { MediaAssetView } from "./mediaClient";
import { clearMediaSlot, mediaSrc, setMediaSlot } from "./mediaClient";
import { MEDIA_KIND_META } from "./mediaKindMeta";

// ── MediaSlot — the image/audio/video bundle ─────────────────────

export interface MediaSlotProps {
	value: Media | undefined;
	onChange: (next: Media | undefined) => void;
	/** Which kinds this carrier can hold. Menu carriers omit "video". */
	kinds: readonly MediaKind[];
}

export function MediaSlot({ value, onChange, kinds }: MediaSlotProps) {
	const setKind = (kind: MediaKind, assetId: string) =>
		onChange(setMediaSlot(value, kind, assetId));
	const clearKind = (kind: MediaKind) => onChange(clearMediaSlot(value, kind));

	return (
		<div className="flex flex-col gap-1.5">
			{kinds.map((kind) => {
				const assetId = value?.[kind];
				return assetId ? (
					<AssetChip
						key={kind}
						kind={kind}
						assetId={assetId}
						onReplace={(asset) => setKind(kind, asset.id)}
						onRemove={() => clearKind(kind)}
					/>
				) : (
					<AddPill
						key={kind}
						kind={kind}
						onPick={(asset) => setKind(kind, asset.id)}
					/>
				);
			})}
		</div>
	);
}

// ── SingleAssetSlot — one fixed-kind id ──────────────────────────

export interface SingleAssetSlotProps {
	value: string | undefined;
	onChange: (next: string | undefined) => void;
	kind: MediaKind;
	/**
	 * Accessible name for the slot's controls. Standalone slots (form
	 * icon, app logo) live outside a labelled editor section, so the
	 * kind alone ("Image") doesn't say WHICH slot — pass e.g. "Form
	 * menu icon". Defaults to the kind label.
	 */
	ariaLabel?: string;
}

export function SingleAssetSlot({
	value,
	onChange,
	kind,
	ariaLabel,
}: SingleAssetSlotProps) {
	return value ? (
		<AssetChip
			kind={kind}
			assetId={value}
			ariaLabel={ariaLabel}
			onReplace={(asset) => onChange(asset.id)}
			onRemove={() => onChange(undefined)}
		/>
	) : (
		<AddPill
			kind={kind}
			ariaLabel={ariaLabel}
			onPick={(asset) => onChange(asset.id)}
		/>
	);
}

// ── Shared pieces ────────────────────────────────────────────────

/** The empty-slot affordance: a dashed "+ Kind" pill that opens the picker. */
function AddPill({
	kind,
	onPick,
	ariaLabel,
}: {
	kind: MediaKind;
	onPick: (asset: MediaAssetView) => void;
	ariaLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const meta = MEDIA_KIND_META[kind];
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label={ariaLabel ?? `Add ${meta.label.toLowerCase()}`}
				className="flex items-center gap-1.5 self-start rounded-md border border-dashed border-nova-border px-2 py-1 text-xs text-nova-text-muted transition-colors hover:border-nova-accent hover:text-nova-text"
			>
				<Icon icon={tablerPlus} className="size-3.5" />
				{meta.label}
			</button>
			<MediaPickerDialog
				open={open}
				onOpenChange={setOpen}
				kind={kind}
				onPick={onPick}
			/>
		</>
	);
}

/** A filled slot: thumbnail + name, opening a preview popover with replace/remove. */
function AssetChip({
	kind,
	assetId,
	onReplace,
	onRemove,
	ariaLabel,
}: {
	kind: MediaKind;
	assetId: string;
	onReplace: (asset: MediaAssetView) => void;
	onRemove: () => void;
	ariaLabel?: string;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const meta = MEDIA_KIND_META[kind];
	// Each control names the slot ("Replace form menu icon") so the chip
	// needs no wrapping landmark of its own.
	const what = ariaLabel ?? meta.label.toLowerCase();
	return (
		<div className="flex items-center gap-2 self-start rounded-md border border-nova-border bg-nova-surface p-1 pr-2">
			<Popover.Root>
				<Popover.Trigger
					className="flex items-center gap-2 rounded outline-none"
					aria-label={`Preview ${what}`}
				>
					<ThumbBox kind={kind} assetId={assetId} />
					<span className="text-xs text-nova-text-muted">{meta.label}</span>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Positioner
						side="top"
						sideOffset={6}
						className={POPOVER_POSITIONER_ELEVATED_CLS}
					>
						<Popover.Popup className={`${POPOVER_POPUP_CLS} max-w-xs p-3`}>
							<AssetPreview kind={kind} assetId={assetId} />
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>

			<button
				type="button"
				onClick={() => setPickerOpen(true)}
				aria-label={`Replace ${what}`}
				className="rounded p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text"
			>
				<Icon icon={tablerReplace} className="size-3.5" />
			</button>
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Remove ${what}`}
				className="rounded p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-error"
			>
				<Icon icon={tablerTrash} className="size-3.5" />
			</button>

			<MediaPickerDialog
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				kind={kind}
				onPick={onReplace}
			/>
		</div>
	);
}

/** 28px thumbnail — image bitmap, or a kind glyph for audio/video. */
function ThumbBox({ kind, assetId }: { kind: MediaKind; assetId: string }) {
	if (kind === "image") {
		return (
			// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
			<img
				src={mediaSrc(assetId)}
				alt=""
				className="size-7 rounded object-cover"
			/>
		);
	}
	return (
		<span className="flex size-7 items-center justify-center rounded bg-nova-deep">
			<Icon
				icon={MEDIA_KIND_META[kind].icon}
				className="size-4 text-nova-text-muted"
			/>
		</span>
	);
}

/** Larger preview inside the popover — image bitmap or a native player. */
function AssetPreview({ kind, assetId }: { kind: MediaKind; assetId: string }) {
	const src = mediaSrc(assetId);
	if (kind === "image") {
		return (
			// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
			<img
				src={src}
				alt=""
				className="max-h-48 w-full rounded object-contain"
			/>
		);
	}
	if (kind === "audio") {
		// biome-ignore lint/a11y/useMediaCaption: author-supplied media; no caption track available
		return <audio src={src} controls className="w-full" />;
	}
	// biome-ignore lint/a11y/useMediaCaption: author-supplied media; no caption track available
	return <video src={src} controls className="max-h-48 w-full rounded" />;
}
