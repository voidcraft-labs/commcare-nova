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
// BOTH attach entry points run the export-ceiling budget check
// (`useAttachBudget.ts`) before dispatching — a library pick rejects as
// a toast, a staged confirm rejects on its chip, each with the same
// prose the SA/MCP verdict speaks — so an over-budget app is something
// an honest user can't build toward an export-time surprise.
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

import { Icon } from "@iconify/react/offline";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import tablerReplace from "@iconify-icons/tabler/replace";
import tablerTrash from "@iconify-icons/tabler/trash";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { IconSlotKind } from "@/lib/domain/builtinIcons";
import {
	isMediaKind,
	type Media,
	type MediaKind,
} from "@/lib/domain/multimedia";
import {
	useAppId,
	useProjectScopeEpoch,
	useStagedUpload,
	useStagedUploadsFor,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { StagedUpload } from "@/lib/session/types";
import { ASSET_KIND_META } from "./assetKindMeta";
import { MediaPickerDialog } from "./MediaPickerDialog";
import {
	clearMediaSlot,
	type MediaAssetView,
	setMediaSlot,
} from "./mediaClient";
import {
	ProjectMediaAudio,
	ProjectMediaImage,
	ProjectMediaVideo,
} from "./ProjectMediaResource";
import { useAttachBudgetGuard } from "./useAttachBudget";
import { useStagedSlotUpload } from "./useStagedUpload";

/**
 * Record a picker's loaded library pages into the session's asset
 * registry — the "already-loaded library rows" the attach budget check
 * resolves referenced ids against without a fetch.
 */
function useRecordLoadedAssets(): (assets: MediaAssetView[]) => void {
	const session = useBuilderSessionApi();
	const scopeEpoch = useProjectScopeEpoch();
	return useCallback(
		(assets: MediaAssetView[]) => {
			const state = session.getState();
			if (state.scopeEpoch !== scopeEpoch || state.accessPhase !== "authorized")
				return;
			session.getState().recordAssetMeta(assets);
		},
		[scopeEpoch, session],
	);
}

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
	const appId = useAppId();
	const checkAttachBudget = useAttachBudgetGuard();
	const recordLoadedAssets = useRecordLoadedAssets();
	const projectToast = useProjectToast();

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
				appId={appId}
				onAssetsLoaded={recordLoadedAssets}
				// The picker is media-scoped for a carrier, so a picked asset is
				// always a media kind; the `isMediaKind` narrow makes that
				// type-safe (`setMediaSlot` keys the bundle by `MediaKind`) and
				// is an inert guard at runtime. The attach budget check runs
				// BEFORE the dispatch — a pick that would breach the export
				// ceiling never reaches the doc; the shared prose lands as a
				// toast (the picker has already closed).
				onPick={(asset) => {
					if (!isMediaKind(asset.kind)) return;
					const kind = asset.kind;
					const start = session.getState();
					if (start.accessPhase !== "authorized") return;
					const pickScopeEpoch = start.scopeEpoch;
					void checkAttachBudget(asset).then((verdict) => {
						const current = session.getState();
						if (
							current.scopeEpoch !== pickScopeEpoch ||
							current.accessPhase !== "authorized"
						)
							return;
						if (!verdict.ok) {
							projectToast(
								"warning",
								"Couldn't attach this file",
								verdict.error,
							);
							return;
						}
						onChangeRef.current(setMediaSlot(valueRef.current, kind, asset.id));
					});
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

/**
 * The built-in icon family an image slot should offer, or `undefined` when it
 * shouldn't. Only menu-tile icon slots qualify (`module:`/`caselist:`/`form:` +
 * `:icon`): module and case-list tiles take topic icons, form tiles take action
 * icons. The app logo, field/option message media, image-map cells, and audio
 * slots all fall through to `undefined`, so the Icon Library never appears there
 * (image questions and non-icon attachments aren't menu tiles).
 */
function iconLibraryFamilyFor(
	slotKey: string,
	kind: MediaKind,
): IconSlotKind | undefined {
	if (kind !== "image") return undefined;
	const match = /^(module|caselist|form):.+:icon$/.exec(slotKey);
	if (!match) return undefined;
	return match[1] === "form" ? "form" : "module";
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
	const appId = useAppId();
	const checkAttachBudget = useAttachBudgetGuard();
	const recordLoadedAssets = useRecordLoadedAssets();
	const projectToast = useProjectToast();

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
				appId={appId}
				iconLibrary={iconLibraryFamilyFor(slotKey, kind)}
				onAssetsLoaded={recordLoadedAssets}
				// Budget BEFORE dispatch — an over-ceiling pick never reaches
				// the doc; the shared prose lands as a toast (the picker has
				// already closed).
				onPick={(asset) => {
					const start = session.getState();
					if (start.accessPhase !== "authorized") return;
					const pickScopeEpoch = start.scopeEpoch;
					void checkAttachBudget(asset).then((verdict) => {
						const current = session.getState();
						if (
							current.scopeEpoch !== pickScopeEpoch ||
							current.accessPhase !== "authorized"
						)
							return;
						if (!verdict.ok) {
							projectToast(
								"warning",
								"Couldn't attach this file",
								verdict.error,
							);
							return;
						}
						onChangeRef.current(asset.id);
					});
				}}
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
		<Button
			type="button"
			variant="outline"
			onClick={onClick}
			className="h-11 self-start border-dashed px-3 text-sm text-nova-text-secondary not-disabled:hover:border-nova-violet not-disabled:hover:text-nova-text"
		>
			<Icon icon={tablerPaperclip} className="size-4" />
			{label}
		</Button>
	);
}

/**
 * A staged slot upload: kind glyph + filename with a live progress bar
 * and a cancel — or, after a failure, the error with a dismiss. The chip
 * is pure session state (`stagedUploads`); nothing it shows is in the
 * doc, which is exactly the contract — the doc gets the reference only
 * when the upload confirms.
 */
/** @internal Exported for focused state/accessibility coverage. */
export function StagedUploadChip({
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
			role={failed ? "alert" : "status"}
			aria-live={failed ? undefined : "polite"}
			aria-atomic="true"
			className={`flex min-h-11 gap-2 self-start rounded-lg border bg-nova-surface p-1 ${
				failed ? "border-nova-rose/40" : "border-nova-border"
			} ${failed ? "max-w-md items-start" : "max-w-72 items-center"}`}
		>
			<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-nova-deep">
				<Icon
					icon={meta.icon}
					className={`size-4 ${failed ? "text-nova-rose" : "text-nova-text-muted"}`}
				/>
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-[13px] leading-snug text-nova-text [overflow-wrap:anywhere]">
					{upload.filename}
				</p>
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
					// The complete actionable error stays visible inline. A tooltip-only
					// message is unavailable to touch users and easy to miss by keyboard.
					<p className="mt-1 text-sm leading-snug text-nova-rose">
						{status.message}
					</p>
				)}
			</div>
			<SimpleTooltip content={failed ? "Dismiss" : "Cancel upload"}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={failed ? onDismiss : onCancel}
					aria-label={
						failed
							? `Dismiss failed upload of ${upload.filename}`
							: `Cancel upload of ${upload.filename}`
					}
					className="size-11 shrink-0 text-nova-text-muted not-disabled:hover:text-nova-rose"
				>
					<Icon icon={tablerX} className="size-4" />
				</Button>
			</SimpleTooltip>
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
		<div className="flex min-h-11 items-center gap-1 self-start rounded-lg border border-nova-border bg-nova-surface p-1">
			<Popover>
				<PopoverTrigger
					render={
						<Button
							variant="ghost"
							className="h-11 gap-2 px-1.5 text-nova-text-secondary"
						/>
					}
					aria-label={`Preview ${noun}`}
				>
					<ThumbBox kind={kind} assetId={assetId} />
					<span className="text-[13px]">{meta.label}</span>
				</PopoverTrigger>
				<PopoverContent
					side="top"
					sideOffset={6}
					className="w-auto max-w-xs p-3"
				>
					<AssetPreview kind={kind} assetId={assetId} />
				</PopoverContent>
			</Popover>

			<SimpleTooltip content={`Replace ${noun}`}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onReplace}
					aria-label={`Replace ${noun}`}
					className="size-11 text-nova-text-muted"
				>
					<Icon icon={tablerReplace} className="size-4" />
				</Button>
			</SimpleTooltip>
			<SimpleTooltip content={`Remove ${noun}`}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onRemove}
					aria-label={`Remove ${noun}`}
					className="size-11 text-nova-text-muted not-disabled:hover:text-nova-rose"
				>
					<Icon icon={tablerTrash} className="size-4" />
				</Button>
			</SimpleTooltip>
		</div>
	);
}

/** Compact thumbnail: image bitmap, or a kind glyph for audio/video. */
function ThumbBox({ kind, assetId }: { kind: MediaKind; assetId: string }) {
	if (kind === "image") {
		return (
			<ProjectMediaImage
				assetId={assetId}
				alt=""
				className="size-9 rounded-md object-cover"
			/>
		);
	}
	return (
		<span className="flex size-9 items-center justify-center rounded-md bg-nova-deep">
			<Icon
				icon={ASSET_KIND_META[kind].icon}
				className="size-4 text-nova-text-muted"
			/>
		</span>
	);
}

/** Larger preview inside the popover — image bitmap or a native player. */
function AssetPreview({ kind, assetId }: { kind: MediaKind; assetId: string }) {
	if (kind === "image") {
		return (
			<ProjectMediaImage
				assetId={assetId}
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
		return <ProjectMediaAudio assetId={assetId} controls className="w-72" />;
	}
	return (
		<ProjectMediaVideo
			assetId={assetId}
			controls
			className="max-h-48 w-full rounded"
		/>
	);
}
