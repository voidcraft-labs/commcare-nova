// components/builder/media/MediaSlot.tsx
//
// The media-attach affordances every carrier mounts:
//
//  - `MediaSlot` — the `Media` bundle (image / audio / video, each
//    independent). Renders the attached assets as removable chips plus a
//    single "Attach" control that opens the picker. The picker's type
//    filter is how a carrier with several allowed kinds chooses what to
//    add — one entry point, not one pill per kind.
//  - `SingleAssetSlot` — one `AssetId` of a fixed kind (module icon,
//    case-list icon, app logo). One chip, one "Attach" control.
//
// Controls name themselves by kind ("Remove image", "Preview audio");
// `ariaLabel`, when a carrier passes it, names the GROUP those controls
// belong to (the field/option/slot) — so a screen reader hears "Label
// Media group, Remove image" without any name being stitched together
// from substrings. The picker derives its own title from its kinds.
//
// Both speak only ids to their carrier; the picker resolves bytes +
// metadata. The preview popover is colocated here (it's an
// implementation detail of the chip, not a standalone surface).

"use client";

import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import tablerReplace from "@iconify-icons/tabler/replace";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useState } from "react";
import {
	isMediaKind,
	type Media,
	type MediaKind,
} from "@/lib/domain/multimedia";
import {
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
} from "@/lib/styles";
import { MediaPickerDialog } from "./MediaPickerDialog";
import { clearMediaSlot, mediaSrc, setMediaSlot } from "./mediaClient";
import { MEDIA_KIND_META } from "./mediaKindMeta";

// ── MediaSlot — the image/audio/video bundle ─────────────────────

export interface MediaSlotProps {
	value: Media | undefined;
	onChange: (next: Media | undefined) => void;
	/** Which kinds this carrier can hold. Menu carriers omit "video". */
	kinds: readonly MediaKind[];
	/**
	 * Accessible name for the control GROUP — the field, option, or slot
	 * these controls belong to (e.g. "Label Media", "Option 1"). Not
	 * stitched into each control's name; it labels the group so the
	 * per-kind control names stay clean. Omitted when an adjacent visible
	 * label already identifies the slot.
	 */
	ariaLabel?: string;
}

/**
 * Which kinds the open picker offers. "Attach" opens it to every kind
 * the carrier allows (with the type filter); a chip's "Replace" opens
 * it locked to that one kind so a swap can't land in a different slot.
 */
interface PickerState {
	open: boolean;
	kinds: readonly MediaKind[];
}

export function MediaSlot({
	value,
	onChange,
	kinds,
	ariaLabel,
}: MediaSlotProps) {
	const [picker, setPicker] = useState<PickerState>({ open: false, kinds });
	// Attached kinds in the carrier's canonical order, so the chips read
	// image → audio → video regardless of which was added first.
	const attached = kinds.filter((kind) => value?.[kind]);
	const allFilled = attached.length === kinds.length;
	const groupProps = ariaLabel
		? ({ role: "group", "aria-label": ariaLabel } as const)
		: {};

	return (
		<div className="flex flex-wrap items-center gap-1.5" {...groupProps}>
			{attached.map((kind) => (
				<AssetChip
					key={kind}
					kind={kind}
					assetId={value?.[kind] as string}
					onReplace={() => setPicker({ open: true, kinds: [kind] })}
					onRemove={() => onChange(clearMediaSlot(value, kind))}
				/>
			))}
			{!allFilled && (
				<AttachButton
					// Once something is attached, the control adds another kind
					// rather than the first — "Add" reads truer than a second
					// "Attach".
					label={attached.length === 0 ? "Attach" : "Add"}
					onClick={() => setPicker({ open: true, kinds })}
				/>
			)}
			<MediaPickerDialog
				open={picker.open}
				onOpenChange={(open) => setPicker((prev) => ({ ...prev, open }))}
				kinds={picker.kinds}
				// The picker is media-scoped for a carrier, so a picked asset is
				// always a media kind; the `isMediaKind` narrow makes that
				// type-safe (`setMediaSlot` keys the bundle by `MediaKind`) and
				// is an inert guard at runtime.
				onPick={(asset) => {
					if (isMediaKind(asset.kind)) {
						onChange(setMediaSlot(value, asset.kind, asset.id));
					}
				}}
			/>
		</div>
	);
}

// ── SingleAssetSlot — one fixed-kind id ──────────────────────────

export interface SingleAssetSlotProps {
	value: string | undefined;
	onChange: (next: string | undefined) => void;
	kind: MediaKind;
	/**
	 * Accessible name for the control group. Standalone slots (form icon,
	 * app logo) live outside a labelled editor section, so the kind alone
	 * ("Image") doesn't say WHICH slot — pass e.g. "Form menu icon".
	 */
	ariaLabel?: string;
}

export function SingleAssetSlot({
	value,
	onChange,
	kind,
	ariaLabel,
}: SingleAssetSlotProps) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const groupProps = ariaLabel
		? ({ role: "group", "aria-label": ariaLabel } as const)
		: {};

	return (
		<div className="flex flex-wrap items-center gap-1.5" {...groupProps}>
			{value ? (
				<AssetChip
					kind={kind}
					assetId={value}
					onReplace={() => setPickerOpen(true)}
					onRemove={() => onChange(undefined)}
				/>
			) : (
				<AttachButton label="Attach" onClick={() => setPickerOpen(true)} />
			)}
			<MediaPickerDialog
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				kinds={[kind]}
				onPick={(asset) => onChange(asset.id)}
			/>
		</div>
	);
}

// ── Shared pieces ────────────────────────────────────────────────

/** The empty-slot affordance: a dashed "Attach" button that opens the picker. */
function AttachButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 self-start rounded-md border border-dashed border-nova-border px-2 py-1 text-xs text-nova-text-muted transition-colors hover:border-nova-violet hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
		>
			<Icon icon={tablerPaperclip} className="size-3.5" />
			{label}
		</button>
	);
}

/** A filled slot: thumbnail + name, opening a preview popover, with replace/remove. */
function AssetChip({
	kind,
	assetId,
	onReplace,
	onRemove,
}: {
	kind: MediaKind;
	assetId: string;
	onReplace: () => void;
	onRemove: () => void;
}) {
	const meta = MEDIA_KIND_META[kind];
	// Controls name themselves by kind; the enclosing group's aria-label
	// supplies which slot, so "Remove image" needs no slot context inline.
	const noun = meta.label.toLowerCase();
	return (
		<div className="flex items-center gap-2 self-start rounded-md border border-nova-border bg-nova-surface p-1 pr-2">
			<Popover.Root>
				<Popover.Trigger
					className="flex items-center gap-2 rounded outline-none focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
					aria-label={`Preview ${noun}`}
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
				onClick={onReplace}
				aria-label={`Replace ${noun}`}
				className="rounded p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
			>
				<Icon icon={tablerReplace} className="size-3.5" />
			</button>
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Remove ${noun}`}
				className="rounded p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-rose focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
			>
				<Icon icon={tablerTrash} className="size-3.5" />
			</button>
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
