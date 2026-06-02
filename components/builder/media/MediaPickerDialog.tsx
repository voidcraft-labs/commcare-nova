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

import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useRef, useState } from "react";
import {
	type MediaKind,
	mediaKindForMimeType,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import type { MediaAssetView } from "./mediaClient";
import { mediaSrc } from "./mediaClient";
import { MEDIA_KIND_META } from "./mediaKindMeta";
import { useMediaLibrary, useMediaUpload } from "./useMedia";

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

type Tab = "upload" | "library";
/** Library browse filter: one allowed kind, or "all" of them. */
type LibraryFilter = MediaKind | "all";

export interface MediaPickerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The kinds this slot accepts. One kind → the picker is locked to it
	 * (no filter). Several → the Library tab shows a type filter and
	 * Upload accepts any of them. Order is the carrier's canonical order.
	 */
	kinds: readonly MediaKind[];
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
	kinds: readonly MediaKind[];
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
		: `Attach ${MEDIA_KIND_META[kinds[0]].label}`;
	const [filter, setFilter] = useState<LibraryFilter>(
		multiKind ? "all" : kinds[0],
	);
	// "all" → fetch every kind (the library route treats an absent kind
	// as unfiltered); a specific kind narrows the page.
	const libraryKind = filter === "all" ? undefined : filter;
	const { assets, isLoading, error, hasMore, loadMore, addUploaded } =
		useMediaLibrary(libraryKind);

	const commit = (asset: MediaAssetView) => {
		addUploaded(asset);
		onPick(asset);
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
						// The type filter only makes sense when more than one
						// kind is browsable; a single-kind library is already
						// narrowed by the fetch.
						filter={multiKind ? filter : null}
						kinds={kinds}
						onFilterChange={setFilter}
					/>
				)}
			</div>
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
function describeKinds(kinds: readonly MediaKind[]): {
	nounPhrase: string;
	accept: string;
} {
	const labels = kinds.map((k) => MEDIA_KIND_META[k].label.toLowerCase());
	const accept = kinds.map((k) => MEDIA_KIND_META[k].accept).join(",");
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
	kinds: readonly MediaKind[];
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
		// dialog, not drag-drop. Reject a file whose sniffed kind isn't
		// one this slot allows (after normalizing aliases like
		// `image/apng`) so the user gets an instant answer instead of
		// hashing the bytes + a server round trip just to be rejected.
		const dropped = normalizeMimeType(file.type);
		const kind = dropped ? mediaKindForMimeType(dropped) : undefined;
		if (!kind || !kinds.includes(kind)) {
			setKindError(
				`That file isn't ${nounPhrase}. This slot takes ${accept.split(",").join(", ")}.`,
			);
			return;
		}
		setKindError(null);
		const asset = await upload(file);
		if (asset) onUploaded(asset);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps a real file input + button for keyboard/AT access
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
			<Icon icon={tablerCloudUpload} className="size-8 text-nova-text-muted" />
			<p className="text-sm text-nova-text-muted">Drag {nounPhrase} here, or</p>
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
			{(kindError ?? (status.state === "error" ? status.message : null)) && (
				<p className="text-xs text-nova-rose">
					{kindError ?? (status.state === "error" ? status.message : "")}
				</p>
			)}
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
	/** Active browse filter, or `null` to hide the filter row (single-kind slot). */
	filter: LibraryFilter | null;
	kinds: readonly MediaKind[];
	onFilterChange: (filter: LibraryFilter) => void;
}) {
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
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
							{MEDIA_KIND_META[kind].label}
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
					{filtered.map((asset) => (
						<li key={asset.id}>
							<button
								type="button"
								onClick={() => onPick(asset)}
								title={asset.displayName ?? asset.originalFilename}
								className="block aspect-square w-full overflow-hidden rounded-md border border-nova-border bg-nova-surface transition-colors hover:border-nova-violet focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
							>
								<LibraryThumb asset={asset} />
							</button>
						</li>
					))}
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
				icon={MEDIA_KIND_META[asset.kind].icon}
				className="size-6 text-nova-text-muted"
			/>
		</span>
	);
}
