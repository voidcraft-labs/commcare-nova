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

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerTrash from "@iconify-icons/tabler/trash";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/shadcn/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import {
	builtinIconPublicPath,
	builtinIconRef,
	builtinIconsForSlot,
	ICON_CATALOG,
	type IconCatalogEntry,
	type IconSlotKind,
} from "@/lib/domain/builtinIcons";
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

type Tab = "upload" | "library" | "icons";
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
	/**
	 * The app this picker authors for, so the server resolves the app's Project
	 * as the tenant for the Library tab and inline uploads. The builder media
	 * slots pass it; the standalone file manager and chat composer (no app
	 * context) omit it, so the server falls back to the active Project.
	 */
	appId?: string;
	/**
	 * Pick handler — fires when a library item is chosen (or an inline upload
	 * completes), after which the dialog closes. OMITTED by the standalone file
	 * manager (the account-menu "Files" entry): with no carrier to pick into,
	 * clicking a library item opens its preview instead, the Upload tab simply
	 * lands the file in the library, and the dialog titles itself "Your files" and
	 * opens on the Library tab. The carrier media slots and the chat composer pass
	 * it.
	 */
	onPick?: (asset: MediaAssetView) => void;
	/**
	 * When provided, a validated file picked on the Upload tab is handed
	 * OFF instead of uploaded inline: the dialog closes immediately and
	 * the caller stages the upload on its slot (progress + cancel live on
	 * the slot's chip; the attach dispatches on upload confirm). The
	 * builder media slots pass this — the doc must never reference an
	 * asset that isn't ready. The chat file manager omits it and keeps
	 * the inline flow (its attachments are message refs, not doc state).
	 */
	onUploadStart?: (file: File, kind: AssetKind) => void;
	/**
	 * Fires with the library's currently loaded assets whenever a page
	 * lands. The builder slots feed these rows (which carry byte sizes)
	 * into the session's asset registry so the attach budget check
	 * resolves referenced ids against already-loaded data instead of
	 * fetching. The chat file manager omits it.
	 */
	onAssetsLoaded?: (assets: MediaAssetView[]) => void;
	/**
	 * Asset ids currently staged elsewhere in the SAME surface that aren't held
	 * in the blueprint — today, the chat composer's attachment chips. Deleting
	 * one of these from the library is a valid action (chat attachments aren't an
	 * app reference, so the delete isn't blocked), but it would silently strand
	 * the chip, so the confirm dialog warns the user it'll be pulled off the
	 * message. Empty/absent on the builder media slots, which have no such chips.
	 */
	attachedAssetIds?: readonly string[];
	/**
	 * Called after a library asset is successfully deleted, so the caller can
	 * drop any staged reference to it (e.g. remove the chat chip). Fires on every
	 * delete; the caller no-ops when the id isn't one it's staging.
	 */
	onAssetDeleted?: (assetId: string) => void;
	/**
	 * Surfaces the built-in "Icon Library" tab — a curated set of menu-tile icons
	 * the user picks by sight (no upload). ONLY for image icon slots: a module/
	 * caselist slot passes `"module"` (topic icons), a form slot `"form"` (action
	 * icons), and the standalone file manager `"all"` (browse the whole set).
	 * Omitted everywhere else — field/option media, image questions, and the app
	 * logo never offer it. In a picker (with `onPick`) clicking an icon attaches
	 * it; in the file manager (no `onPick`) it previews. Selecting one stores the
	 * reserved `nova-icon:<slug>` ref, resolved to shared bytes at emit.
	 */
	iconLibrary?: IconSlotKind | "all";
}

export function MediaPickerDialog({
	open,
	onOpenChange,
	kinds,
	appId,
	onPick,
	onUploadStart,
	onAssetsLoaded,
	attachedAssetIds,
	onAssetDeleted,
	iconLibrary,
}: MediaPickerDialogProps) {
	// No `onPick` → this is the standalone file manager (see the prop doc): no
	// carrier to pick into, so library clicks preview and Upload just lands files.
	const manage = onPick === undefined;
	// The data hooks (`useMediaLibrary`) live in `PickerBody`, which is
	// a child of `DialogContent` — Base UI only mounts the popup's
	// subtree while the dialog is open, so the library fetch fires when
	// the user opens the picker, NOT eagerly on every slot's mount.
	// (An always-mounted hook here would fire one library GET per slot
	// before any click.) The thin shell stays mounted so the open/close
	// transition still animates.
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg"
			>
				<PickerBody
					manage={manage}
					kinds={kinds}
					appId={appId}
					onPick={(asset) => {
						// Never called in manage mode — library clicks preview there.
						onPick?.(asset);
						onOpenChange(false);
					}}
					onUploadStart={
						onUploadStart &&
						((file, kind) => {
							// Hand the file off and close — the slot's staged chip
							// takes over (progress + cancel); the picker has nothing
							// left to show.
							onUploadStart(file, kind);
							onOpenChange(false);
						})
					}
					onAssetsLoaded={onAssetsLoaded}
					attachedAssetIds={attachedAssetIds}
					onAssetDeleted={onAssetDeleted}
					iconLibrary={iconLibrary}
				/>
			</DialogContent>
		</Dialog>
	);
}

/** Mounted only while the dialog is open (child of `DialogContent`). Owns
 *  the library fetch + tab/filter state so none of it runs until open. */
function PickerBody({
	manage,
	kinds,
	appId,
	onPick,
	onUploadStart,
	onAssetsLoaded,
	attachedAssetIds,
	onAssetDeleted,
	iconLibrary,
}: {
	manage: boolean;
	kinds: readonly AssetKind[];
	appId?: string;
	onPick: (asset: MediaAssetView) => void;
	onUploadStart?: (file: File, kind: AssetKind) => void;
	onAssetsLoaded?: (assets: MediaAssetView[]) => void;
	attachedAssetIds?: readonly string[];
	onAssetDeleted?: (assetId: string) => void;
	iconLibrary?: IconSlotKind | "all";
}) {
	// The built-in icons offered: a slot's family (`module`/`form`) for a picker,
	// the whole set (`all`) for the file manager. Empty → no Icon Library tab.
	const iconEntries = useMemo<readonly IconCatalogEntry[]>(
		() =>
			iconLibrary === undefined
				? []
				: iconLibrary === "all"
					? ICON_CATALOG
					: builtinIconsForSlot(iconLibrary),
		[iconLibrary],
	);
	const showIcons = iconEntries.length > 0;
	// The manager opens on the Library (your existing files); an icon-slot picker
	// opens on the curated Icon Library (the point of the click); any other picker
	// opens on Upload (you came here to add something to a slot).
	const [tab, setTab] = useState<Tab>(
		manage ? "library" : showIcons ? "icons" : "upload",
	);
	// A multi-kind slot gets a browse filter (defaulting to "all"); a
	// single-kind slot is pinned to its one kind with no filter UI.
	const multiKind = kinds.length > 1;
	// The dialog titles itself: "Your files" as the standalone manager, otherwise
	// from its kinds — "Attach Image" when locked to one, "Attach Media" when it
	// accepts several — so callers don't thread a title string (and can't drift it
	// from what's offered).
	const title = manage
		? "Your files"
		: multiKind
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
	} = useMediaLibrary(libraryKinds, appId);

	// Surface each loaded page to the caller (the builder slots record the
	// rows for the attach budget check). The consumer's merge is
	// idempotent, so re-reporting the whole current list per page is fine.
	useEffect(() => {
		if (assets.length > 0) onAssetsLoaded?.(assets);
	}, [assets, onAssetsLoaded]);

	const commit = (asset: MediaAssetView) => {
		addUploaded(asset);
		onPick(asset);
	};

	// Preview a library asset WITHOUT picking it — so a user can check a
	// document's "What Nova reads" extract before attaching. `null` = closed.
	const [previewTarget, setPreviewTarget] = useState<AssetPreviewTarget | null>(
		null,
	);

	// Open an asset's preview without picking it — the eye affordance everywhere,
	// and (in the manager, which has no carrier to pick into) the library item's
	// own click target.
	const openPreview = (asset: MediaAssetView) =>
		setPreviewTarget({
			id: asset.id,
			kind: asset.kind,
			filename: asset.displayName ?? asset.originalFilename,
			title: asset.extract?.title,
			summary: asset.extract?.summary,
		});

	// An Icon Library click: a picker ATTACHES the built-in (the synthetic view
	// carries the reserved `nova-icon:<slug>` id; the attach-budget guard
	// short-circuits it); the file manager (no carrier) PREVIEWS the bitmap.
	const pickIcon = (entry: IconCatalogEntry) => {
		const asset = builtinIconAssetView(entry);
		if (manage) openPreview(asset);
		else onPick(asset);
	};

	// In the manager an inline upload has nowhere to pick to: land the asset in the
	// library and switch to it so the user sees what they just added. Reset the
	// type filter to "all" — the Upload tab accepts any kind, so a kind that
	// doesn't match the active filter would be prepended into a kind-scoped list
	// and then vanish on the next fetch; "all" keeps it in scope (and is the
	// natural "here's everything you have" post-upload view).
	const onManagedUpload = (asset: MediaAssetView) => {
		addUploaded(asset);
		setFilter("all");
		setTab("library");
	};

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
			// Pull any staged reference to the now-gone asset (e.g. the chat
			// composer's chip). A no-op for a caller that wasn't staging it.
			onAssetDeleted?.(asset.id);
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
				<DialogTitle className="font-display">{title}</DialogTitle>
				<DialogClose
					render={<Button variant="ghost" size="icon-sm" />}
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</DialogClose>
			</header>

			<div
				role="tablist"
				aria-label="Media source"
				className="flex gap-1 border-b border-nova-border px-4 pt-3"
			>
				{showIcons && (
					<TabButton active={tab === "icons"} onClick={() => setTab("icons")}>
						Icon Library
					</TabButton>
				)}
				<TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
					Upload
				</TabButton>
				<TabButton active={tab === "library"} onClick={() => setTab("library")}>
					Library
				</TabButton>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{tab === "icons" ? (
					<IconLibraryTab icons={iconEntries} onPickIcon={pickIcon} />
				) : tab === "upload" ? (
					<UploadTab
						kinds={kinds}
						onUploaded={manage ? onManagedUpload : commit}
						onUploadStart={onUploadStart}
						appId={appId}
					/>
				) : (
					<LibraryTab
						assets={assets}
						isLoading={isLoading}
						error={error}
						hasMore={hasMore}
						loadMore={loadMore}
						// In the manager a click previews (nothing to pick into); in a
						// picker it commits the choice and closes.
						onPick={manage ? openPreview : commit}
						onPreview={openPreview}
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
				attached={
					deleteTarget !== null &&
					(attachedAssetIds?.includes(deleteTarget.id) ?? false)
				}
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
	onUploadStart,
	appId,
}: {
	kinds: readonly AssetKind[];
	onUploaded: (asset: MediaAssetView) => void;
	/** Delegate a validated file to the caller's staged flow instead of
	 *  uploading inline — see `MediaPickerDialogProps.onUploadStart`. */
	onUploadStart?: (file: File, kind: AssetKind) => void;
	/** Scopes an inline upload to this app's Project (the chat composer); the
	 *  account-menu file manager omits it (uploads to the active Project). */
	appId?: string;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [kindError, setKindError] = useState<string | null>(null);
	const { upload, status } = useMediaUpload(appId);
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
		// The validated file either hands off to the caller's staged flow
		// (builder slots — the dialog closes and the slot chip owns
		// progress/cancel/attach-on-confirm) or uploads inline (the chat
		// file manager).
		if (onUploadStart) {
			onUploadStart(file, kind);
			return;
		}
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
				<Button
					type="button"
					size="sm"
					onClick={() => inputRef.current?.click()}
					disabled={status.state === "uploading"}
				>
					{status.state === "uploading" ? "Uploading…" : "Browse files"}
				</Button>
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
					<span className="text-center text-[10px] uppercase tracking-wider text-nova-text-muted">
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
				<Button
					type="button"
					variant="outline"
					size="xs"
					className="self-center"
					onClick={loadMore}
					disabled={isLoading}
				>
					{isLoading ? "Loading…" : "Load more"}
				</Button>
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
					? "bg-nova-action text-white"
					: "bg-nova-surface text-nova-text-muted hover:text-nova-text"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * A `MediaAssetView` standing in for a built-in icon, built from its catalog
 * entry. Its id is the reserved `nova-icon:<slug>` ref the slot stores; the
 * other fields back the preview header + `mediaSrc` (which routes a built-in id
 * to its static bytes). There is no `media_assets` row — built-ins never reach the
 * library list or the budget fetch.
 */
function builtinIconAssetView(entry: IconCatalogEntry): MediaAssetView {
	return {
		id: builtinIconRef(entry.slug),
		contentHash: entry.contentHash,
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: entry.sizeBytes,
		originalFilename: `${entry.slug}.png`,
		displayName: entry.label,
		status: "ready",
		createdAt: "",
	};
}

/**
 * The built-in Icon Library: a searchable grid of curated menu-tile icons the
 * user picks by sight, no upload. `icons` is already scoped to the slot's family
 * (topic icons for a module/caselist slot, action icons for a form slot) or the
 * whole set in the file manager.
 */
function IconLibraryTab({
	icons,
	onPickIcon,
}: {
	icons: readonly IconCatalogEntry[];
	onPickIcon: (entry: IconCatalogEntry) => void;
}) {
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return icons;
		return icons.filter(
			(e) =>
				e.label.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q),
		);
	}, [icons, query]);

	return (
		<div className="flex flex-col gap-3">
			<input
				type="text"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search icons"
				autoComplete="off"
				data-1p-ignore
				className="w-full rounded-md border border-nova-border bg-nova-surface px-3 py-1.5 text-sm text-nova-text outline-none placeholder:text-nova-text-muted focus:border-nova-violet"
			/>
			{filtered.length === 0 ? (
				<p className="py-6 text-center text-sm text-nova-text-muted">
					No matching icons.
				</p>
			) : (
				<ul className="grid grid-cols-4 gap-2">
					{filtered.map((entry) => (
						<li key={entry.slug}>
							<button
								type="button"
								onClick={() => onPickIcon(entry)}
								className="block aspect-square w-full overflow-hidden rounded-md border border-nova-border bg-nova-surface transition-colors hover:border-nova-violet focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
							>
								{/* biome-ignore lint/performance/noImgElement: a tiny fixed static PNG from /nova-icons; next/image adds no value */}
								<img
									src={builtinIconPublicPath(entry.slug)}
									alt={entry.label}
									className="size-full object-contain p-1.5"
								/>
							</button>
							<Tooltip>
								<TooltipTrigger
									render={
										<p className="mt-1.5 truncate text-center text-xs leading-tight text-nova-text">
											{entry.label}
										</p>
									}
								/>
								<TooltipContent>{entry.label}</TooltipContent>
							</Tooltip>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * Confirm-before-delete dialog for a library asset. Stacks over the z-modal
 * picker by portal order (its portal mounts later, on the same z plane).
 * Alert semantics — no outside-press dismissal, Cancel / Delete only — which
 * is right for a destructive action.
 */
function MediaDeleteConfirmDialog({
	target,
	attached,
	deleting,
	onConfirm,
	onCancel,
}: {
	/** The asset awaiting confirmation, or `null` when the dialog is closed. */
	target: MediaAssetView | null;
	/** True when this asset is currently attached to the chat message (staged as
	 *  a composer chip). Adds a line warning the delete will pull it off the
	 *  message, since the chip can't survive its asset being gone. */
	attached: boolean;
	/** True while the delete request is in flight (locks the controls). */
	deleting: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const name = target ? (target.displayName ?? target.originalFilename) : "";
	return (
		<AlertDialog
			open={target !== null}
			onOpenChange={(open) => {
				// Ignore close attempts (e.g. Escape) while the delete is in flight.
				if (!open && !deleting) onCancel();
			}}
		>
			<AlertDialogContent className="text-left">
				<AlertDialogHeader>
					<AlertDialogTitle className="font-display">
						Delete file?
					</AlertDialogTitle>
					<AlertDialogDescription>
						<span className="font-medium text-nova-text-secondary">{name}</span>{" "}
						will be removed from your library. This can't be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{attached && (
					<p className="flex items-start gap-2 rounded-md border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-2 text-left text-xs leading-relaxed text-nova-text-secondary">
						<Icon
							icon={tablerAlertTriangle}
							className="mt-0.5 size-3.5 shrink-0 text-nova-amber"
						/>
						<span>
							It's attached to your current message — deleting it will also
							remove it from the chat.
						</span>
					</p>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
					{/* Solid rose with dark text (light accents carry dark text) —
					 * the confirm side of a destructive alert is the one place the
					 * fill is full-strength rather than the tinted `destructive`
					 * button variant. */}
					<AlertDialogAction
						onClick={onConfirm}
						disabled={deleting}
						className="bg-nova-rose text-nova-void not-disabled:hover:bg-[color-mix(in_oklab,var(--nova-rose),black_14%)] focus-visible:ring-nova-rose/40"
					>
						{deleting ? "Deleting…" : "Delete"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
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
