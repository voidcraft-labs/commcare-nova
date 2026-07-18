// components/builder/media/AssetPreviewDialog.tsx
//
// Previews one stored asset. For a document it has two tabs, "What Nova reads"
// first — the requirements extract the Solutions Architect actually sees (and the
// only view office/text docs get, since the "Document" tab just offers a download
// of the raw file) — so a user can confirm what made it into the extract and never
// hit the "but it's right there in the doc!" surprise. For an image / audio / video
// it just shows the media (those reach the model directly, so there's no extract
// to compare).
//
// Raw-document rendering is native-where-it's-free + safe: a PDF renders in an
// <iframe> (the browser's out-of-process viewer — a malicious PDF can't reach
// this page), images/audio/video use the native elements, and office/text files
// have no in-browser preview, so they offer a download of the original rather
// than pretending to render it in-app. The bytes are served by the
// ownership-gated proxy, which stamps a `sandbox` CSP on the response, so the
// embedded document is sandboxed by the server too.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerDownload from "@iconify-icons/tabler/download";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Spinner } from "@/components/shadcn/spinner";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/shadcn/tabs";
import { type AssetKind, isDocumentKind } from "@/lib/domain/multimedia";
import { ChatMarkdown } from "@/lib/markdown";
import { ASSET_KIND_META } from "./assetKindMeta";
import { ExtractionInfoPopover } from "./ExtractionInfoPopover";
import {
	fetchAssetExtract,
	fetchAssetExtractMeta,
	mediaSrc,
} from "./mediaClient";

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
		<Dialog open={target !== null} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
			>
				{target && <PreviewBody target={target} />}
			</DialogContent>
		</Dialog>
	);
}

/** Mounted only while open (child of `DialogContent`), so the extract fetch fires
 *  on open, not on every chip mount. */
function PreviewBody({ target }: { target: AssetPreviewTarget }) {
	const name = target.filename;
	const isDocument = isDocumentKind(target.kind);

	// Fill the header from the snapshot when it has the title/summary (composer +
	// library snapshots are reconciled, so they do — instant, no fetch). A message
	// attachment SENT before extraction finished froze its ref empty; for that
	// case alone, fetch the header metadata so the preview is still correct.
	const [fetched, setFetched] = useState<{
		title?: string;
		summary?: string;
	} | null>(null);
	useEffect(() => {
		if (!isDocument || target.title || target.summary) return;
		let cancelled = false;
		fetchAssetExtractMeta(target.id).then((meta) => {
			if (!cancelled && meta) setFetched(meta);
		});
		return () => {
			cancelled = true;
		};
	}, [isDocument, target.id, target.title, target.summary]);
	const title = target.title ?? fetched?.title;
	const summary = target.summary ?? fetched?.summary;

	return (
		<>
			<header className="flex shrink-0 items-start justify-between gap-4 border-b border-nova-border px-5 py-4">
				<div className="flex min-w-0 flex-col gap-0.5">
					{/* The human title leads (the meaningful name); the raw filename
					 *  drops to a small subline aligned under it. Without an extracted
					 *  title (media, or a not-yet-extracted doc) the filename IS the
					 *  title, and the subline is omitted so nothing repeats. */}
					<DialogTitle className="flex min-w-0 items-center gap-2 font-display">
						<Icon
							icon={ASSET_KIND_META[target.kind].icon}
							className="size-4 shrink-0 text-nova-text-muted"
						/>
						<span className="min-w-0 [overflow-wrap:anywhere]">
							{title ?? name}
						</span>
					</DialogTitle>
					{title && (
						<p className="pl-6 text-xs leading-snug text-nova-text-muted [overflow-wrap:anywhere]">
							{name}
						</p>
					)}
				</div>
				<DialogClose
					render={
						<Button
							variant="ghost"
							className="h-11 shrink-0 px-3 text-nova-text-secondary"
						/>
					}
				>
					<Icon icon={tablerX} className="size-4" />
					Close
				</DialogClose>
			</header>

			{/* The summary gets its own zone below the header — document-level
			 *  orientation that reads against either tab — so the title row stays a
			 *  tight identity line instead of carrying a multi-line blurb. */}
			{summary && (
				<div className="shrink-0 border-b border-nova-border px-4 py-3">
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{summary}
					</p>
				</div>
			)}

			{isDocument ? (
				<Tabs
					defaultValue="extract"
					className="min-h-0 flex-1 gap-0 overflow-hidden p-5 pt-3"
				>
					<TabsList variant="line" className="mb-3 h-12 shrink-0">
						{/* "What Nova reads" leads — it's what the SA actually sees, and
						 *  the only view office/text docs have (the Document tab just
						 *  offers a download). The explainer sits beside the tab it
						 *  describes, not in the picker header. */}
						<TabsTrigger value="extract" className="min-h-11 px-3">
							What Nova reads
						</TabsTrigger>
						<span className="flex items-center">
							<ExtractionInfoPopover />
						</span>
						<TabsTrigger value="document" className="min-h-11 px-3">
							Document
						</TabsTrigger>
					</TabsList>
					<TabsContent value="extract" className="min-h-0 overflow-auto">
						<ExtractView assetId={target.id} />
					</TabsContent>
					<TabsContent value="document" className="min-h-0 overflow-auto">
						<DocumentView target={target} />
					</TabsContent>
				</Tabs>
			) : (
				<div className="min-h-0 flex-1 overflow-auto p-5">
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
			<p className="max-w-lg text-sm text-nova-text-secondary">
				Nova doesn't preview {ASSET_KIND_META[kind].label} files here. Download
				the original to open it, or switch to{" "}
				<span className="text-nova-text">What Nova reads</span> to see what Nova
				extracted.
			</p>
			<Button
				nativeButton={false}
				render={<a href={src} download={name} />}
				className="h-11 px-4"
			>
				<Icon icon={tablerDownload} className="size-4" />
				Download original
			</Button>
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
				className="size-10 text-nova-text-muted"
			/>
			<p className="text-sm text-nova-text-secondary">
				This file is no longer available. It may have been deleted from your
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
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		// `attempt` is an intentional retry key: changing it reruns this request even
		// when the asset itself has not changed.
		void attempt;
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
						err instanceof Error
							? err.message
							: "Couldn't load what Nova reads",
				});
			});
		return () => {
			cancelled = true;
		};
	}, [assetId, attempt]);

	if (extract.state === "loading") {
		return (
			<div className="flex min-h-44 flex-col items-center justify-center gap-3 text-sm text-nova-text-secondary">
				<Spinner className="size-5" aria-label="Loading what Nova reads" />
				Loading what Nova reads…
			</div>
		);
	}
	if (extract.state === "absent") {
		// The extract endpoint 404s both for a doc that hasn't finished extracting
		// AND for one whose asset is gone (deleted) — the client can't tell them
		// apart, so the copy honestly covers both rather than asserting "not read
		// yet" over a file that no longer exists.
		return (
			<ExtractStatePanel
				title="Nothing to show yet"
				description="Nova may still be reading this document, or the file may no longer be available"
				action="Check again"
				onAction={() => setAttempt((current) => current + 1)}
			/>
		);
	}
	if (extract.state === "error") {
		return (
			<ExtractStatePanel
				title="What Nova reads couldn't be loaded"
				description={extract.message}
				action="Retry"
				onAction={() => setAttempt((current) => current + 1)}
				error
			/>
		);
	}
	// Render the extract as markdown inside a quiet frame. The extract is built
	// from untrusted document bytes piped through the summarizer, so we render it
	// with `ChatMarkdown` — the same allowlist the SA's chat output uses: raw HTML
	// is inert text (`disableParsingRawHTML`), links collapse to their text, and
	// images to their alt text. That leaves headings, emphasis, lists, tables, and
	// rules (what the extractor actually emits) with no script/link/image surface.
	return (
		<div className="chat-markdown break-words rounded-md border border-nova-border bg-nova-surface p-4 text-sm text-nova-text-secondary">
			<ChatMarkdown>{extract.text}</ChatMarkdown>
		</div>
	);
}

function ExtractStatePanel({
	title,
	description,
	action,
	onAction,
	error = false,
}: {
	title: string;
	description: string;
	action: string;
	onAction: () => void;
	error?: boolean;
}) {
	return (
		<div
			role={error ? "alert" : undefined}
			className="flex min-h-44 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-nova-border px-5 py-8 text-center"
		>
			<div className="space-y-1">
				<p className="text-base font-medium text-nova-text">{title}</p>
				<p
					className={
						error
							? "text-sm text-nova-rose"
							: "text-sm text-nova-text-secondary"
					}
				>
					{description}
				</p>
			</div>
			<Button
				type="button"
				variant="outline"
				className="h-11 px-4"
				onClick={onAction}
			>
				{action}
			</Button>
		</div>
	);
}
