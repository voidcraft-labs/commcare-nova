// components/builder/media/MediaPickerDialog.tsx
//
// The pick-or-upload dialog the media slots open. Two tabs:
//
//  - Upload — drag-and-drop or browse; runs the client upload flow
//    (hash → initiate → PUT → confirm), then commits the asset.
//  - Library — the owner's existing `ready` assets of this kind,
//    newest first, paginated; click one to pick it.
//
// A freshly uploaded asset is prepended to the library list (so it's
// visible if the user switches tabs) and committed immediately via
// `onPick`. The dialog speaks only `MediaAssetView` to its caller;
// the carrier decides what to store (the asset id).

"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useRef, useState } from "react";
import type { MediaKind } from "@/lib/domain/multimedia";
import type { MediaAssetView } from "./mediaClient";
import { mediaSrc } from "./mediaClient";
import { MEDIA_KIND_META } from "./mediaKindMeta";
import { useMediaLibrary, useMediaUpload } from "./useMedia";

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

type Tab = "upload" | "library";

export interface MediaPickerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: MediaKind;
	onPick: (asset: MediaAssetView) => void;
}

export function MediaPickerDialog({
	open,
	onOpenChange,
	kind,
	onPick,
}: MediaPickerDialogProps) {
	// The data hooks (`useMediaLibrary`) live in `PickerBody`, which is
	// a child of `Dialog.Popup` — Base UI only mounts the Popup's
	// subtree while the dialog is open, so the library fetch fires when
	// the user opens the picker, NOT eagerly on every slot's mount.
	// (An always-mounted hook here would fire one library GET per slot
	// per kind before any click.) The thin shell stays mounted so the
	// open/close transition still animates.
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={BACKDROP_CLS} />
				<Dialog.Popup className={POPUP_CLS}>
					<PickerBody
						kind={kind}
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
 *  the library fetch + tab state so neither runs until the picker opens. */
function PickerBody({
	kind,
	onPick,
}: {
	kind: MediaKind;
	onPick: (asset: MediaAssetView) => void;
}) {
	const [tab, setTab] = useState<Tab>("upload");
	const meta = MEDIA_KIND_META[kind];
	const { assets, isLoading, error, hasMore, loadMore, addUploaded } =
		useMediaLibrary(kind);

	const commit = (asset: MediaAssetView) => {
		addUploaded(asset);
		onPick(asset);
	};

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-4 py-3">
				<Dialog.Title className="text-base font-display font-semibold text-nova-text">
					Add {meta.label.toLowerCase()}
				</Dialog.Title>
				<Dialog.Close
					className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text"
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
					<UploadTab kind={kind} onUploaded={commit} />
				) : (
					<LibraryTab
						assets={assets}
						isLoading={isLoading}
						error={error}
						hasMore={hasMore}
						loadMore={loadMore}
						onPick={commit}
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
			className={`-mb-px border-b-2 px-3 pb-2 text-sm transition-colors ${
				active
					? "border-nova-accent text-nova-text"
					: "border-transparent text-nova-text-muted hover:text-nova-text"
			}`}
		>
			{children}
		</button>
	);
}

function UploadTab({
	kind,
	onUploaded,
}: {
	kind: MediaKind;
	onUploaded: (asset: MediaAssetView) => void;
}) {
	const meta = MEDIA_KIND_META[kind];
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const { upload, status } = useMediaUpload();

	const handleFile = async (file: File | undefined) => {
		if (!file) return;
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
					? "border-nova-accent bg-nova-accent/[0.06]"
					: "border-nova-border"
			}`}
		>
			<Icon icon={tablerCloudUpload} className="size-8 text-nova-text-muted" />
			<p className="text-sm text-nova-text-muted">
				Drag a {meta.label.toLowerCase()} here, or
			</p>
			<button
				type="button"
				onClick={() => inputRef.current?.click()}
				disabled={status.state === "uploading"}
				className="rounded-md bg-nova-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
			>
				{status.state === "uploading" ? "Uploading…" : "Browse files"}
			</button>
			<input
				ref={inputRef}
				type="file"
				accept={meta.accept}
				autoComplete="off"
				data-1p-ignore
				className="hidden"
				onChange={(e) => void handleFile(e.target.files?.[0])}
			/>
			{status.state === "error" && (
				<p className="text-xs text-nova-error">{status.message}</p>
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
}: {
	assets: MediaAssetView[];
	isLoading: boolean;
	error: string | null;
	hasMore: boolean;
	loadMore: () => void;
	onPick: (asset: MediaAssetView) => void;
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
			<input
				type="text"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search by name"
				autoComplete="off"
				data-1p-ignore
				className="w-full rounded-md border border-nova-border bg-nova-surface px-3 py-1.5 text-sm text-nova-text outline-none placeholder:text-nova-text-muted focus:border-nova-accent"
			/>
			{error && <p className="text-xs text-nova-error">{error}</p>}
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
								className="block aspect-square w-full overflow-hidden rounded-md border border-nova-border bg-nova-surface transition-colors hover:border-nova-accent"
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
					className="self-center rounded-md border border-nova-border px-3 py-1 text-xs text-nova-text-muted transition-colors hover:text-nova-text disabled:opacity-50"
				>
					{isLoading ? "Loading…" : "Load more"}
				</button>
			)}
		</div>
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
