// components/builder/media/MediaPickerDialog.tsx
//
// The pick-or-upload dialog the media slots open. Two tabs:
//
//  - Upload — drag-and-drop or browse; runs the client upload flow
//    (hash → initiate → PUT → confirm), then commits the asset.
//  - Library — the owner's existing `ready` assets, newest first,
//    paginated; click one to pick it.
//
// The dialog serves slots that allow ONE kind (a module icon, the app
// logo) and slots that allow several (a question's display media can
// be image / audio / video). When more than one kind is allowed the
// Library tab shows a type filter, and Upload accepts any allowed kind
// — the picked file's sniffed kind routes it to the right sub-slot in
// the carrier. The dialog speaks only `MediaAssetView` to its caller;
// the carrier decides what to store (the asset id).

"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerTrash from "@iconify-icons/tabler/trash";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useRef, useState } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import {
	type AssetKind,
	assetKindForFilename,
	assetKindForMimeType,
	isDocumentKind,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import { showToast } from "@/lib/ui/toastStore";
import {
	AssetPreviewDialog,
	type AssetPreviewTarget,
} from "./AssetPreviewDialog";
import { ASSET_KIND_META } from "./assetKindMeta";
import { ExtractionStatusBadge } from "./ExtractionStatusBadge";
import {
	deleteMediaAsset,
	type ExtractMeta,
	type MediaAssetView,
	mediaSrc,
} from "./mediaClient";
import { useMediaLibrary, useMediaUpload } from "./useMedia";

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

type Tab = "upload" | "library";
/** Library browse filter: one allowed kind, or "all" of them. */
type LibraryFilter = AssetKind | "all";

export interface MediaPickerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The kinds this slot accepts. One kind → the picker is locked to it
	 * (no filter). Several → the Library tab shows a type filter and
	 * Upload accepts any of them. Order is the carrier's canonical order.
	 */
	kinds: readonly AssetKind[];
	onPick: (asset: MediaAssetView) => void;
}

export function MediaPickerDialog({
	open,
	onOpenChange,
	kinds,
	onPick,
}: MediaPickerDialogProps) {
	// The data hooks (`useMediaLibrary`) live in `PickerBody`, which is
	// a child of `Dialog.Popup` — Base UI only mounts the Popup's
	// subtree while the dialog is open, so the library fetch fires when
	// the user opens the picker, NOT eagerly on every slot's mount.
	// (An always-mounted hook here would fire one library GET per slot
	// before any click.) The thin shell stays mounted so the open/close
	// transition still animates.
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={BACKDROP_CLS} />
				<Dialog.Popup className={POPUP_CLS}>
					<PickerBody
						kinds={kinds}
						onPick={(asset) => {
							onPick(asset);
							onOpenChange(false);
						}}
					/>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** Mounted only while the dialog is open (child of `Dialog.Popup`). Owns
 *  the library fetch + tab/filter state so none of it runs until open. */
function PickerBody({
	kinds,
	onPick,
}: {
	kinds: readonly AssetKind[];
	onPick: (asset: MediaAssetView) => void;
}) {
	const [tab, setTab] = useState<Tab>("upload");
	// A multi-kind slot gets a browse filter (defaulting to "all"); a
	// single-kind slot is pinned to its one kind with no filter UI.
	const multiKind = kinds.length > 1;
	// The dialog titles itself from its kinds — "Attach Image" when locked
	// to one, "Attach Media" when it accepts several — so callers don't
	// thread a title string (and can't drift it from what's offered).
	const title = multiKind
		? "Attach Media"
		: `Attach ${ASSET_KIND_META[kinds[0]].label}`;
	const [filter, setFilter] = useState<LibraryFilter>(
		multiKind ? "all" : kinds[0],
	);
	// "All" → fetch exactly THIS picker's allowed kinds, so the server returns
	// only attachable assets rather than a page of irrelevant kinds (e.g. a chat
	// picker's audio/video) the client would then have to hide — which buried the
	// few attachable docs behind "Load more". A specific filter narrows to one
	// kind. Memoized so it isn't a fresh array each render (the hook keys off the
	// contents, but a stable reference keeps the dependency honest).
	const libraryKinds = useMemo<readonly AssetKind[]>(
		() => (filter === "all" ? kinds : [filter]),
		[filter, kinds],
	);
	const {
		assets,
		isLoading,
		error,
		hasMore,
		loadMore,
		addUploaded,
		removeAsset,
		updateAsset,
	} = useMediaLibrary(libraryKinds);

	const commit = (asset: MediaAssetView) => {
		addUploaded(asset);
		onPick(asset);
	};

	// Preview a library asset WITHOUT picking it — so a user can check a
	// document's "What Nova reads" extract before attaching. `null` = closed.
	const [previewTarget, setPreviewTarget] = useState<AssetPreviewTarget | null>(
		null,
	);

	// Delete a library asset, with confirmation. `deleteTarget` holds the asset
	// awaiting confirmation (`null` = no dialog); `deleting` disables the dialog's
	// controls while the request is in flight.
	const [deleteTarget, setDeleteTarget] = useState<MediaAssetView | null>(null);
	const [deleting, setDeleting] = useState(false);

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		const asset = deleteTarget;
		const name = asset.displayName ?? asset.originalFilename;
		setDeleting(true);
		try {
			await deleteMediaAsset(asset.id);
			removeAsset(asset.id);
			showToast("info", "File deleted", name);
			setDeleteTarget(null);
		} catch (err) {
			// A 409 (still referenced by one of your apps) or any failure: tell the
			// user WHY — the message names the carriers — and leave the asset.
			showToast(
				"warning",
				"Couldn't delete file",
				err instanceof Error ? err.message : "Please try again.",
			);
			setDeleteTarget(null);
		} finally {
			setDeleting(false);
		}
	};

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-4 py-3">
				<Dialog.Title className="text-base font-display font-semibold text-nova-text">
					{title}
				</Dialog.Title>
				<Dialog.Close
					className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</Dialog.Close>
			</header>

			<div
				role="tablist"
				aria-label="Media source"
				className="flex gap-1 border-b border-nova-border px-4 pt-3"
			>
				<TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
					Upload
				</TabButton>
				<TabButton active={tab === "library"} onClick={() => setTab("library")}>
					Library
				</TabButton>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{tab === "upload" ? (
					<UploadTab kinds={kinds} onUploaded={commit} />
				) : (
					<LibraryTab
						assets={assets}
						isLoading={isLoading}
						error={error}
						hasMore={hasMore}
						loadMore={loadMore}
						onPick={commit}
						onPreview={(asset) =>
							setPreviewTarget({
								id: asset.id,
								kind: asset.kind,
								filename: asset.displayName ?? asset.originalFilename,
								title: asset.extract?.title,
								summary: asset.extract?.summary,
							})
						}
						onDelete={setDeleteTarget}
						// Fold a freshly completed extract into the list so a preview
						// opened right after upload shows its title/summary without
						// waiting for a re-fetch.
						onExtracted={(assetId, extract) =>
							updateAsset(assetId, { extract })
						}
						// The type filter only makes sense when more than one
						// kind is browsable; a single-kind library is already
						// narrowed by the fetch.
						filter={multiKind ? filter : null}
						kinds={kinds}
						onFilterChange={setFilter}
					/>
				)}
			</div>

			{/* Preview opens OVER the picker (its portal mounts after, so it
			 *  stacks on top); closing it returns to the library. */}
			<AssetPreviewDialog
				target={previewTarget}
				onOpenChange={(open) => {
					if (!open) setPreviewTarget(null);
				}}
			/>

			{/* Delete confirmation — also portals after the picker, so it stacks
			 *  on top at the same z-modal tier. */}
			<MediaDeleteConfirmDialog
				target={deleteTarget}
				deleting={deleting}
				onConfirm={confirmDelete}
				onCancel={() => {
					if (!deleting) setDeleteTarget(null);
				}}
			/>
		</>
	);
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={`-mb-px border-b-2 px-3 pb-2 text-sm transition-colors focus-visible:outline-1 focus-visible:outline-nova-violet-bright ${
				active
					? "border-nova-violet text-nova-text"
					: "border-transparent text-nova-text-muted hover:text-nova-text"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * Human "a/an image, audio, or video" phrase + the combined `accept`
 * MIME list, both derived from the allowed kinds so the upload-tab copy
 * and the wrong-kind rejection name exactly what the slot takes.
 */
function describeKinds(kinds: readonly AssetKind[]): {
	nounPhrase: string;
	accept: string;
} {
	const labels = kinds.map((k) => ASSET_KIND_META[k].label.toLowerCase());
	const accept = kinds.map((k) => ASSET_KIND_META[k].accept).join(",");
	// "image" → "an image"; "image"/"audio" → "an image or audio";
	// "image"/"audio"/"video" → "an image, audio, or video".
	const article = /^[aeiou]/.test(labels[0] ?? "") ? "an" : "a";
	let nounPhrase: string;
	if (labels.length === 1) {
		nounPhrase = `${article} ${labels[0]}`;
	} else if (labels.length === 2) {
		nounPhrase = `${article} ${labels[0]} or ${labels[1]}`;
	} else {
		nounPhrase = `${article} ${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;
	}
	return { nounPhrase, accept };
}

function UploadTab({
	kinds,
	onUploaded,
}: {
	kinds: readonly AssetKind[];
	onUploaded: (asset: MediaAssetView) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [kindError, setKindError] = useState<string | null>(null);
	const { upload, status } = useMediaUpload();
	const { nounPhrase, accept } = useMemo(() => describeKinds(kinds), [kinds]);

	const handleFile = async (file: File | undefined) => {
		if (!file) return;
		// The native input's `accept` filter only guards the browse
		// dialog, not drag-drop. Reject a file whose kind isn't one this
		// slot allows so the user gets an instant answer instead of hashing
		// the bytes + a server round trip just to be rejected. Resolve the
		// kind from the browser's MIME (after normalizing aliases like
		// `image/apng`), falling back to the filename extension — browsers
		// set `File.type` to "" or `application/octet-stream` for `.md` and
		// some office files, which would otherwise reject a valid document.
		const dropped = normalizeMimeType(file.type);
		const kind =
			(dropped ? assetKindForMimeType(dropped) : undefined) ??
			assetKindForFilename(file.name);
		// `kind` is the wider `AssetKind`; `some` (not `includes`) lets us
		// compare it against this picker's narrower allowed set without a
		// cast. A kind outside the set (e.g. a document on a media carrier)
		// is rejected here.
		if (!kind || !kinds.some((k) => k === kind)) {
			const supported = kinds
				.map(
					(k) => `${ASSET_KIND_META[k].label} (${ASSET_KIND_META[k].extLabel})`,
				)
				.join(", ");
			setKindError(
				`That file isn't ${nounPhrase}. This slot takes ${supported}.`,
			);
			return;
		}
		setKindError(null);
		const asset = await upload(file);
		if (asset) onUploaded(asset);
	};

	return (
		<div className="flex flex-col gap-3">
			{/* PHI guardrail — Nova reads documents and stores the extract, so real
			 *  patient data must not ride along. Shown only where documents are
			 *  accepted (the chat file manager), not on media-only carriers. */}
			{kinds.some(isDocumentKind) && (
				<p className="flex items-start gap-2 rounded-md border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-2 text-left text-xs leading-relaxed text-nova-text-secondary">
					<Icon
						icon={tablerAlertTriangle}
						className="mt-0.5 size-3.5 shrink-0 text-nova-amber"
					/>
					<span>
						Don't upload real patient data (PHI). Use sample or de-identified
						documents — Nova reads them and stores the extract.
					</span>
				</p>
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps a real file input + button for keyboard/AT access */}
			<div
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragging(false);
					void handleFile(e.dataTransfer.files[0]);
				}}
				className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
					dragging
						? "border-nova-violet bg-nova-violet/[0.06]"
						: "border-nova-border"
				}`}
			>
				<Icon
					icon={tablerCloudUpload}
					className="size-8 text-nova-text-muted"
				/>
				<p className="text-sm text-nova-text-muted">
					Drag {nounPhrase} here, or
				</p>
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					disabled={status.state === "uploading"}
					className="rounded-md bg-nova-violet px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nova-violet-bright disabled:opacity-50"
				>
					{status.state === "uploading" ? "Uploading…" : "Browse files"}
				</button>
				<input
					ref={inputRef}
					type="file"
					accept={accept}
					autoComplete="off"
					data-1p-ignore
					className="hidden"
					onChange={(e) => void handleFile(e.target.files?.[0])}
				/>
				{/* Spell out exactly what this slot takes — one row per allowed
			    kind with its extensions — so the user knows before they
			    browse, not after a rejection. This is the only set the slot
			    accepts; anything else is filtered out here and in the
			    library. */}
				<div className="flex flex-col gap-1 pt-1">
					<span className="text-center text-[10px] uppercase tracking-wider text-nova-text-muted/70">
						{kinds.length === 1 ? "Supported format" : "Supported formats"}
					</span>
					{kinds.map((kind) => {
						const meta = ASSET_KIND_META[kind];
						return (
							<div
								key={kind}
								className="flex items-center justify-center gap-1.5 text-xs"
							>
								<Icon
									icon={meta.icon}
									className="size-3.5 shrink-0 text-nova-text-muted"
								/>
								<span className="text-nova-text-secondary">{meta.label}</span>
								<span className="text-nova-text-muted">{meta.extLabel}</span>
							</div>
						);
					})}
				</div>
				{(kindError ?? (status.state === "error" ? status.message : null)) && (
					<p className="text-xs text-nova-rose">
						{kindError ?? (status.state === "error" ? status.message : "")}
					</p>
				)}
			</div>
		</div>
	);
}

function LibraryTab({
	assets,
	isLoading,
	error,
	hasMore,
	loadMore,
	onPick,
	onPreview,
	onDelete,
	onExtracted,
	filter,
	kinds,
	onFilterChange,
}: {
	assets: MediaAssetView[];
	isLoading: boolean;
	error: string | null;
	hasMore: boolean;
	loadMore: () => void;
	onPick: (asset: MediaAssetView) => void;
	/** Open the preview for an asset without picking it. */
	onPreview: (asset: MediaAssetView) => void;
	/** Request deletion of an asset (opens the confirmation dialog). */
	onDelete: (asset: MediaAssetView) => void;
	/** A document's extraction completed — reconcile its snapshot in the list. */
	onExtracted: (assetId: string, extract: ExtractMeta) => void;
	/** Active browse filter, or `null` to hide the filter row (single-kind slot). */
	filter: LibraryFilter | null;
	kinds: readonly AssetKind[];
	onFilterChange: (filter: LibraryFilter) => void;
}) {
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		// Kind scoping now happens server-side: the fetch requests exactly this
		// picker's allowed kinds (see `libraryKinds`), so every loaded asset is
		// already attachable here — no client-side kind filter needed. Only the
		// name search narrows the in-hand page.
		const q = query.trim().toLowerCase();
		if (!q) return assets;
		return assets.filter((a) =>
			(a.displayName ?? a.originalFilename).toLowerCase().includes(q),
		);
	}, [assets, query]);

	return (
		<div className="flex flex-col gap-3">
			{filter !== null && (
				<div
					role="tablist"
					aria-label="Filter by type"
					className="flex flex-wrap gap-1"
				>
					<FilterChip
						active={filter === "all"}
						onClick={() => onFilterChange("all")}
					>
						All
					</FilterChip>
					{kinds.map((kind) => (
						<FilterChip
							key={kind}
							active={filter === kind}
							onClick={() => onFilterChange(kind)}
						>
							{ASSET_KIND_META[kind].label}
						</FilterChip>
					))}
				</div>
			)}
			<input
				type="text"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search by name"
				autoComplete="off"
				data-1p-ignore
				className="w-full rounded-md border border-nova-border bg-nova-surface px-3 py-1.5 text-sm text-nova-text outline-none placeholder:text-nova-text-muted focus:border-nova-violet"
			/>
			{error && <p className="text-xs text-nova-rose">{error}</p>}
			{filtered.length === 0 && !isLoading ? (
				<p className="py-6 text-center text-sm text-nova-text-muted">
					{assets.length === 0
						? "Nothing here yet — upload one from the Upload tab."
						: "No matches."}
				</p>
			) : (
				<ul className="grid grid-cols-3 gap-2">
					{filtered.map((asset) => {
						const fileName = asset.displayName ?? asset.originalFilename;
						// Documents gain an extracted title once extraction succeeds;
						// show it as a subtitle so the library reads as human names. Skip
						// it when it just echoes the filename (no signal added).
						const extractedTitle = asset.extract?.title;
						const docTitle =
							extractedTitle && extractedTitle !== fileName
								? extractedTitle
								: undefined;
						return (
							<li key={asset.id} className="group">
								{/* The thumbnail + its hover affordances form their own
								 *  positioning context, so the absolute overlays anchor to
								 *  the square and not to the taller li (which now also holds
								 *  the caption below). */}
								<div className="relative">
									<button
										type="button"
										onClick={() => onPick(asset)}
										className="block aspect-square w-full overflow-hidden rounded-md border border-nova-border bg-nova-surface transition-colors hover:border-nova-violet focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
									>
										<LibraryThumb asset={asset} />
									</button>
									{/* Preview without picking — a sibling of the pick button
									 *  (not nested), revealed on hover/focus. Lets a user check
									 *  a document's "What Nova reads" extract before attaching.
									 *  Tooltip.Root emits no DOM, so the button stays an absolute
									 *  sibling anchored to the relative wrapper. */}
									<Tooltip>
										<TooltipTrigger
											render={
												<button
													type="button"
													onClick={() => onPreview(asset)}
													aria-label={`Preview ${fileName}`}
													className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md bg-nova-deep/80 text-nova-text-muted opacity-0 backdrop-blur-sm transition-opacity hover:text-nova-text focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-nova-violet-bright group-hover:opacity-100"
												>
													<Icon icon={tablerEye} className="size-3.5" />
												</button>
											}
										/>
										<TooltipContent>Preview</TooltipContent>
									</Tooltip>
									{/* Delete — a sibling of the pick button (not nested),
									 *  top-left so it doesn't collide with the preview
									 *  affordance. Opens a confirmation before removing the
									 *  asset from the library. */}
									<Tooltip>
										<TooltipTrigger
											render={
												<button
													type="button"
													onClick={() => onDelete(asset)}
													aria-label={`Delete ${fileName}`}
													className="absolute top-1 left-1 flex size-6 items-center justify-center rounded-md bg-nova-deep/80 text-nova-text-muted opacity-0 backdrop-blur-sm transition-opacity hover:text-nova-rose focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-nova-rose group-hover:opacity-100"
												>
													<Icon icon={tablerTrash} className="size-3.5" />
												</button>
											}
										/>
										<TooltipContent>Delete</TooltipContent>
									</Tooltip>
									{/* Extraction indicator for documents — a sibling of the
									 *  pick button (not nested), so the failed-state retry
									 *  control isn't interactive content inside a button.
									 *  Renders nothing for media kinds. */}
									{isDocumentKind(asset.kind) && (
										<div className="pointer-events-none absolute inset-x-1 bottom-1 flex justify-center [&>*]:pointer-events-auto">
											<ExtractionStatusBadge
												asset={asset}
												onExtracted={(extract) =>
													onExtracted(asset.id, extract)
												}
											/>
										</div>
									)}
								</div>
								{/* Caption — the filename is always visible, with the extracted
								 *  title beneath it for documents. Both single-line-clamp; a hover
								 *  tooltip reveals the full value when it's truncated. */}
								<div className="mt-1.5 space-y-0.5">
									<Tooltip>
										<TooltipTrigger
											render={
												<p className="truncate text-xs leading-tight text-nova-text">
													{fileName}
												</p>
											}
										/>
										<TooltipContent>{fileName}</TooltipContent>
									</Tooltip>
									{docTitle && (
										<Tooltip>
											<TooltipTrigger
												render={
													<p className="truncate text-[11px] leading-tight text-nova-text-muted">
														{docTitle}
													</p>
												}
											/>
											<TooltipContent>{docTitle}</TooltipContent>
										</Tooltip>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{hasMore && (
				<button
					type="button"
					onClick={loadMore}
					disabled={isLoading}
					className="self-center rounded-md border border-nova-border px-3 py-1 text-xs text-nova-text-muted transition-colors hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright disabled:opacity-50"
				>
					{isLoading ? "Loading…" : "Load more"}
				</button>
			)}
		</div>
	);
}

/** A small segmented-control chip for the Library type filter. */
function FilterChip({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={`rounded-full px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-1 focus-visible:outline-nova-violet-bright ${
				active
					? "bg-nova-violet text-white"
					: "bg-nova-surface text-nova-text-muted hover:text-nova-text"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * Confirm-before-delete dialog for a library asset. Built on Base UI's
 * alert-dialog rather than the shadcn `AlertDialog` because that component is
 * pinned to the z-popover tier and would render BEHIND this z-modal picker; this
 * matches the picker + preview dialogs in the same file (z-modal, nova-themed,
 * stacking over the picker by portal order). Alert semantics — no outside-press
 * dismissal, Cancel / Delete only — which is right for a destructive action.
 */
function MediaDeleteConfirmDialog({
	target,
	deleting,
	onConfirm,
	onCancel,
}: {
	/** The asset awaiting confirmation, or `null` when the dialog is closed. */
	target: MediaAssetView | null;
	/** True while the delete request is in flight (locks the controls). */
	deleting: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const name = target ? (target.displayName ?? target.originalFilename) : "";
	return (
		<AlertDialog.Root
			open={target !== null}
			onOpenChange={(open) => {
				// Ignore close attempts (e.g. Escape) while the delete is in flight.
				if (!open && !deleting) onCancel();
			}}
		>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop className="fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
				<AlertDialog.Popup className="fixed top-1/2 left-1/2 z-modal w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-nova-border bg-nova-deep p-5 shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
					<AlertDialog.Title className="font-display text-base font-semibold text-nova-text">
						Delete file?
					</AlertDialog.Title>
					<AlertDialog.Description className="mt-1.5 text-sm text-nova-text-muted">
						<span className="font-medium text-nova-text-secondary">{name}</span>{" "}
						will be removed from your library. This can't be undone.
					</AlertDialog.Description>
					<div className="mt-4 flex justify-end gap-2">
						<AlertDialog.Close
							disabled={deleting}
							className="rounded-md border border-nova-border px-3 py-1.5 text-sm text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright disabled:opacity-50"
						>
							Cancel
						</AlertDialog.Close>
						<button
							type="button"
							onClick={onConfirm}
							disabled={deleting}
							className="rounded-md bg-nova-rose px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nova-rose disabled:opacity-50"
						>
							{deleting ? "Deleting…" : "Delete"}
						</button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

/** Thumbnail cell — images show the bitmap; audio/video show a kind glyph. */
function LibraryThumb({ asset }: { asset: MediaAssetView }) {
	if (asset.kind === "image") {
		return (
			// biome-ignore lint/performance/noImgElement: the proxy route is session-authed; next/image can't carry the cookie auth
			<img
				src={mediaSrc(asset.id)}
				alt={asset.displayName ?? asset.originalFilename}
				className="size-full object-cover"
			/>
		);
	}
	return (
		<span className="flex size-full items-center justify-center">
			<Icon
				icon={ASSET_KIND_META[asset.kind].icon}
				className="size-6 text-nova-text-muted"
			/>
		</span>
	);
}
