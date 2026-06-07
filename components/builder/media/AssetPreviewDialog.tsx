// components/builder/media/AssetPreviewDialog.tsx
//
// Previews one stored asset. For a document it has two tabs — "Document" (the
// raw file) and "What Nova reads" (the requirements extract the Solutions
// Architect actually sees) — so a user can confirm what made it into the
// extract and never hit the "but it's right there in the doc!" surprise. For an
// image / audio / video it just shows the media (those reach the model directly,
// so there's no extract to compare).
//
// Raw-document rendering is native-where-it's-free + safe: a PDF renders in an
// <iframe> (the browser's out-of-process viewer — a malicious PDF can't reach
// this page), images/audio/video use the native elements, and office/text files
// have no in-browser preview, so they offer a download of the original rather
// than pretending to render it in-app. The bytes are served by the
// ownership-gated proxy, which stamps a `sandbox` CSP on the response, so the
// embedded document is sandboxed by the server too.

"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerDownload from "@iconify-icons/tabler/download";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useState } from "react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/shadcn/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import { type AssetKind, isDocumentKind } from "@/lib/domain/multimedia";
import { ASSET_KIND_META } from "./assetKindMeta";
import { ExtractionInfoPopover } from "./ExtractionInfoPopover";
import { fetchAssetExtract, mediaSrc } from "./mediaClient";

/**
 * The minimal handle the preview needs: the asset id (for the bytes proxy +
 * extract fetch), its kind (which renderer + whether there's an extract tab),
 * and a display name. Both a picked library asset (`MediaAssetView`) and a
 * message's attachment ref (`AttachmentRef`) reduce to this, so one dialog
 * serves the composer and the transcript.
 */
export interface AssetPreviewTarget {
	id: string;
	kind: AssetKind;
	filename: string;
	/** A document's extracted title + summary, shown in the preview header so
	 *  they're present the instant the dialog opens — carried in-band by the
	 *  caller (the composer's asset view, the message ref), never re-fetched.
	 *  Absent for media kinds and documents not yet extracted. */
	title?: string;
	summary?: string;
}

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

export interface AssetPreviewDialogProps {
	/** The asset to preview; `null` closes the dialog. */
	target: AssetPreviewTarget | null;
	onOpenChange: (open: boolean) => void;
}

export function AssetPreviewDialog({
	target,
	onOpenChange,
}: AssetPreviewDialogProps) {
	return (
		<Dialog.Root open={target !== null} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={BACKDROP_CLS} />
				<Dialog.Popup className={POPUP_CLS}>
					{target && <PreviewBody target={target} />}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** Mounted only while open (child of `Dialog.Popup`), so the extract fetch fires
 *  on open, not on every chip mount. */
function PreviewBody({ target }: { target: AssetPreviewTarget }) {
	const name = target.filename;
	const isDocument = isDocumentKind(target.kind);

	return (
		<>
			<header className="flex items-start justify-between gap-3 border-b border-nova-border px-4 py-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					{/* The human title leads (the meaningful name); the raw filename
					 *  drops to a small subline aligned under it. Without an extracted
					 *  title (media, or a not-yet-extracted doc) the filename IS the
					 *  title, and the subline is omitted so nothing repeats. */}
					<Dialog.Title className="flex min-w-0 items-center gap-2 text-base font-display font-semibold text-nova-text">
						<Icon
							icon={ASSET_KIND_META[target.kind].icon}
							className="size-4 shrink-0 text-nova-text-muted"
						/>
						<span className="truncate">{target.title ?? name}</span>
					</Dialog.Title>
					{target.title && (
						<Tooltip>
							<TooltipTrigger
								render={
									<p className="truncate pl-6 text-xs text-nova-text-muted">
										{name}
									</p>
								}
							/>
							<TooltipContent>{name}</TooltipContent>
						</Tooltip>
					)}
				</div>
				<Dialog.Close
					className="shrink-0 rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</Dialog.Close>
			</header>

			{/* The summary gets its own zone below the header — document-level
			 *  orientation that reads against either tab — so the title row stays a
			 *  tight identity line instead of carrying a multi-line blurb. */}
			{target.summary && (
				<div className="shrink-0 border-b border-nova-border px-4 py-3">
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{target.summary}
					</p>
				</div>
			)}

			{isDocument ? (
				<Tabs defaultValue="document" className="min-h-0 flex-1 gap-0 p-4 pt-3">
					<TabsList variant="line" className="mb-3">
						<TabsTrigger value="document">Document</TabsTrigger>
						<TabsTrigger value="extract">What Nova reads</TabsTrigger>
						{/* The "What Nova reads" explainer sits beside the tab it
						 *  describes, not in the picker header — it's about the extract,
						 *  which is what this tab shows. */}
						<span className="ml-1 flex items-center">
							<ExtractionInfoPopover />
						</span>
					</TabsList>
					<TabsContent value="document" className="min-h-0 overflow-auto">
						<DocumentView target={target} />
					</TabsContent>
					<TabsContent value="extract" className="min-h-0 overflow-auto">
						<ExtractView assetId={target.id} />
					</TabsContent>
				</Tabs>
			) : (
				<div className="min-h-0 flex-1 overflow-auto p-4">
					<DocumentView target={target} />
				</div>
			)}
		</>
	);
}

/**
 * The raw-file view, dispatched by kind. A referenced asset can be deleted from
 * the library while a transcript message still shows its chip, so the media
 * elements fall back to a clear "no longer available" tile on a load error
 * (the proxy 404s a deleted/foreign asset) rather than a broken image / frame.
 */
function DocumentView({ target }: { target: AssetPreviewTarget }) {
	const src = mediaSrc(target.id);
	const name = target.filename;
	// A deleted (or foreign) asset 404s on the bytes proxy; the media element's
	// onError flips this so we show an honest fallback, not a broken tile.
	const [unavailable, setUnavailable] = useState(false);
	if (unavailable) return <AssetUnavailable kind={target.kind} />;
	const onError = () => setUnavailable(true);
	switch (target.kind) {
		case "image":
			return (
				// biome-ignore lint/performance/noImgElement: the proxy route is session-authed; next/image can't carry the cookie auth
				<img
					src={src}
					alt={name}
					onError={onError}
					className="mx-auto max-h-[65vh] rounded-md object-contain"
				/>
			);
		case "audio":
			// biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track
			return <audio controls src={src} onError={onError} className="w-full" />;
		case "video":
			return (
				// biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track
				<video
					controls
					src={src}
					onError={onError}
					className="max-h-[65vh] w-full"
				/>
			);
		case "pdf":
			// The browser's native PDF viewer renders out-of-process; the proxy's
			// `sandbox` CSP sandboxes the document as defense-in-depth. (An <iframe>
			// won't reliably fire onError for an HTTP 404 — it renders the browser's
			// own error page instead — so a deleted PDF shows that rather than the
			// tile; not misleading, just less polished than the image case.)
			return (
				<iframe
					src={src}
					title={name}
					onError={onError}
					className="h-[65vh] w-full rounded-md border border-nova-border bg-white"
				/>
			);
		default:
			// docx / xlsx / text — no in-app office renderer (by design). These have
			// no in-browser preview, so we don't pretend: offer a download of the
			// original rather than implying it'll display.
			return <DownloadOriginal src={src} name={name} kind={target.kind} />;
	}
}

/**
 * Fallback for documents Nova doesn't render in-app (Word / Excel / text). There
 * is no in-browser preview for these formats, so this is honest about it: it
 * DOWNLOADS the original (the `download` attribute, so every format behaves the
 * same instead of office files silently downloading while text files display).
 * The "What Nova reads" tab is where the content actually shows.
 */
function DownloadOriginal({
	src,
	name,
	kind,
}: {
	src: string;
	name: string;
	kind: AssetKind;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-nova-border px-6 py-12 text-center">
			<Icon
				icon={ASSET_KIND_META[kind].icon}
				className="size-10 text-nova-text-muted"
			/>
			<p className="text-sm text-nova-text-secondary">
				Nova doesn't preview {ASSET_KIND_META[kind].label} files here — download
				the original to open it, or switch to{" "}
				<span className="text-nova-text">What Nova reads</span> to see what Nova
				extracted.
			</p>
			<a
				href={src}
				download={name}
				className="inline-flex items-center gap-1.5 rounded-md bg-nova-violet px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nova-violet-bright"
			>
				<Icon icon={tablerDownload} className="size-4" />
				Download original
			</a>
		</div>
	);
}

/** Shown when an asset's bytes can't be loaded — typically because it was
 *  deleted from the library while a transcript message still references it.
 *  Honest about the state instead of a broken image or a misleading "not yet
 *  read". */
function AssetUnavailable({ kind }: { kind: AssetKind }) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-nova-border px-6 py-12 text-center">
			<Icon
				icon={ASSET_KIND_META[kind].icon}
				className="size-10 text-nova-text-muted/60"
			/>
			<p className="text-sm text-nova-text-secondary">
				This file is no longer available — it may have been deleted from your
				library.
			</p>
		</div>
	);
}

type ExtractState =
	| { state: "loading" }
	| { state: "ready"; text: string }
	| { state: "absent" }
	| { state: "error"; message: string };

/** The "What Nova reads" panel — fetches the stored extract for the document. */
function ExtractView({ assetId }: { assetId: string }) {
	const [extract, setExtract] = useState<ExtractState>({ state: "loading" });

	useEffect(() => {
		let cancelled = false;
		setExtract({ state: "loading" });
		fetchAssetExtract(assetId)
			.then((text) => {
				if (cancelled) return;
				setExtract(
					text === null ? { state: "absent" } : { state: "ready", text },
				);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setExtract({
					state: "error",
					message:
						err instanceof Error ? err.message : "Couldn't load the extract.",
				});
			});
		return () => {
			cancelled = true;
		};
	}, [assetId]);

	if (extract.state === "loading") {
		return (
			<p className="py-8 text-center text-sm text-nova-text-muted">
				Loading what Nova reads…
			</p>
		);
	}
	if (extract.state === "absent") {
		// The extract endpoint 404s both for a doc that hasn't finished extracting
		// AND for one whose asset is gone (deleted) — the client can't tell them
		// apart, so the copy honestly covers both rather than asserting "not read
		// yet" over a file that no longer exists.
		return (
			<p className="py-8 text-center text-sm text-nova-text-muted">
				No extract to show — the document may still be processing, or it's no
				longer in your library.
			</p>
		);
	}
	if (extract.state === "error") {
		return (
			<p className="py-8 text-center text-sm text-nova-rose">
				{extract.message}
			</p>
		);
	}
	return (
		<pre className="whitespace-pre-wrap break-words rounded-md bg-nova-surface p-3 font-mono text-xs leading-relaxed text-nova-text-secondary">
			{extract.text}
		</pre>
	);
}
