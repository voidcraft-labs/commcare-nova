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
// The doc never references an asset that isn't `ready`, so picking a
// FILE doesn't attach: the picker hands it off (`onUploadStart`), the
// slot stages it in the session store (`stagedUploads`, keyed by
// `slotKey`), and a `StagedUploadChip` shows progress + cancel while the
// upload runs. Only the confirm response — a ready asset — dispatches
// the carrier's `onChange`; a failure shows on the chip with nothing
// committed. Picking an already-ready LIBRARY asset attaches
// immediately. `slotKey` is the carrier slot's stable identity (field
// uuid + bundle key, `module:<uuid>:icon`, `app:logo`, …) so a
// remounted slot re-renders its staged chip from the store.
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
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useRef, useState } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import {
	isMediaKind,
	type Media,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { useStagedUpload, useStagedUploadsFor } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { StagedUpload } from "@/lib/session/types";
import {
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
} from "@/lib/styles";
import { ASSET_KIND_META } from "./assetKindMeta";
import { MediaPickerDialog } from "./MediaPickerDialog";
import { clearMediaSlot, mediaSrc, setMediaSlot } from "./mediaClient";
import { useStagedSlotUpload } from "./useStagedUpload";

// ── MediaSlot — the image/audio/video bundle ─────────────────────

export interface MediaSlotProps {
	value: Media | undefined;
	onChange: (next: Media | undefined) => void;
	/** Which kinds this carrier can hold. Menu carriers omit "video". */
	kinds: readonly MediaKind[];
	/**
	 * Stable identity of this carrier slot — keys the session store's
	 * staged-upload records (per kind, under `<slotKey>/<kind>`), so a
	 * remounted slot re-renders its in-flight chip and cancel still
	 * reaches the transfer. Carriers derive it from their entity's uuid
	 * plus the slot name (e.g. `field:<uuid>:label_media`).
	 */
	slotKey: string;
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
	slotKey,
	ariaLabel,
}: MediaSlotProps) {
	const [picker, setPicker] = useState<PickerState>({ open: false, kinds });
	const staged = useStagedUploadsFor(slotKey);
	const session = useBuilderSessionApi();

	// The confirm-time attach must compose against the carrier's CURRENT
	// bundle (another kind may have attached while the upload ran), and the
	// upload outlives any single render — latest-value refs bridge that.
	const valueRef = useRef(value);
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		valueRef.current = value;
		onChangeRef.current = onChange;
	});
	const startUpload = useStagedSlotUpload((asset, kind) => {
		onChangeRef.current(setMediaSlot(valueRef.current, kind, asset.id));
	});

	// Attached kinds in the carrier's canonical order, so the chips read
	// image → audio → video regardless of which was added first.
	const attached = kinds.filter((kind) => value?.[kind]);
	const stagedKinds = kinds.filter((kind) => staged[kind]);
	const allBusy = kinds.every((kind) => value?.[kind] || staged[kind]);
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
			{stagedKinds.map((kind) => {
				const upload = staged[kind];
				if (!upload) return null;
				const key = `${slotKey}/${kind}`;
				return (
					<StagedUploadChip
						key={`staged-${kind}`}
						upload={upload}
						onCancel={() => session.getState().cancelStagedUpload(key)}
						onDismiss={() => session.getState().clearStagedUpload(key)}
					/>
				);
			})}
			{!allBusy && (
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
				// A picked FILE stages instead of attaching: the upload runs
				// against this slot's staged record, and the attach dispatches
				// only on confirm (see the module header).
				onUploadStart={(file, kind) => {
					if (isMediaKind(kind)) {
						startUpload(`${slotKey}/${kind}`, kind, file);
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
	/** Stable identity of this carrier slot — see `MediaSlotProps.slotKey`.
	 *  Single slots stage directly under it (the kind is fixed). */
	slotKey: string;
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
	slotKey,
	ariaLabel,
}: SingleAssetSlotProps) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const staged = useStagedUpload(slotKey);
	const session = useBuilderSessionApi();

	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});
	const startUpload = useStagedSlotUpload((asset) => {
		onChangeRef.current(asset.id);
	});

	const groupProps = ariaLabel
		? ({ role: "group", "aria-label": ariaLabel } as const)
		: {};

	return (
		<div className="flex flex-wrap items-center gap-1.5" {...groupProps}>
			{value && (
				<AssetChip
					kind={kind}
					assetId={value}
					onReplace={() => setPickerOpen(true)}
					onRemove={() => onChange(undefined)}
				/>
			)}
			{staged && (
				<StagedUploadChip
					upload={staged}
					onCancel={() => session.getState().cancelStagedUpload(slotKey)}
					onDismiss={() => session.getState().clearStagedUpload(slotKey)}
				/>
			)}
			{!value && !staged && (
				<AttachButton label="Attach" onClick={() => setPickerOpen(true)} />
			)}
			<MediaPickerDialog
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				kinds={[kind]}
				onPick={(asset) => onChange(asset.id)}
				onUploadStart={(file, pickedKind) => {
					if (isMediaKind(pickedKind)) {
						startUpload(slotKey, pickedKind, file);
					}
				}}
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

/**
 * A staged slot upload: kind glyph + filename with a live progress bar
 * and a cancel — or, after a failure, the error with a dismiss. The chip
 * is pure session state (`stagedUploads`); nothing it shows is in the
 * doc, which is exactly the contract — the doc gets the reference only
 * when the upload confirms.
 */
function StagedUploadChip({
	upload,
	onCancel,
	onDismiss,
}: {
	upload: StagedUpload;
	onCancel: () => void;
	onDismiss: () => void;
}) {
	const meta = ASSET_KIND_META[upload.kind];
	const status = upload.status;
	const failed = status.state === "error";
	return (
		<div
			role="status"
			className={`flex max-w-64 items-center gap-2 self-start rounded-md border bg-nova-surface p-1 pr-2 ${
				failed ? "border-nova-rose/40" : "border-nova-border"
			}`}
		>
			<span className="flex size-7 shrink-0 items-center justify-center rounded bg-nova-deep">
				<Icon
					icon={meta.icon}
					className={`size-4 ${failed ? "text-nova-rose" : "text-nova-text-muted"}`}
				/>
			</span>
			<div className="min-w-0 flex-1">
				<p className="truncate text-xs text-nova-text">{upload.filename}</p>
				{status.state === "uploading" ? (
					<div
						role="progressbar"
						aria-label={`Uploading ${upload.filename}`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(status.progress * 100)}
						className="mt-1 h-1 w-full min-w-20 overflow-hidden rounded bg-nova-deep"
					>
						<div
							className="h-full rounded bg-nova-violet transition-[width]"
							style={{ width: `${status.progress * 100}%` }}
						/>
					</div>
				) : (
					// The chip is narrow, so the message truncates — the tooltip
					// carries the full Elm-shaped error.
					<Tooltip>
						<TooltipTrigger
							render={
								<p className="truncate text-[11px] leading-tight text-nova-rose">
									{status.message}
								</p>
							}
						/>
						<TooltipContent>{status.message}</TooltipContent>
					</Tooltip>
				)}
			</div>
			<button
				type="button"
				onClick={failed ? onDismiss : onCancel}
				aria-label={
					failed
						? `Dismiss failed upload of ${upload.filename}`
						: `Cancel upload of ${upload.filename}`
				}
				className="shrink-0 rounded p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-rose focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
			>
				<Icon icon={tablerX} className="size-3.5" />
			</button>
		</div>
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
	const meta = ASSET_KIND_META[kind];
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
				icon={ASSET_KIND_META[kind].icon}
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
		// A native `<audio>` player has no intrinsic width, so `w-full` collapses
		// it to 0 inside the shrink-to-fit popover (an `<img>` escapes this because
		// its bitmap gives the popover a width to resolve against). A definite
		// width gives the control bar room to render instead of an empty popover.
		// biome-ignore lint/a11y/useMediaCaption: author-supplied media; no caption track available
		return <audio src={src} controls className="w-72" />;
	}
	// biome-ignore lint/a11y/useMediaCaption: author-supplied media; no caption track available
	return <video src={src} controls className="max-h-48 w-full rounded" />;
}
