// components/builder/media/AssetPreviewDialog.tsx
//
// Previews one stored asset. For a document it has two tabs — "Document" (the
// raw file) and "What the AI reads" (the requirements extract the Solutions
// Architect actually sees) — so a user can confirm what made it into the
// extract and never hit the "but it's right there in the doc!" surprise. For an
// image / audio / video it just shows the media (those reach the model directly,
// so there's no extract to compare).
//
// Raw-document rendering is native-where-it's-free + safe: a PDF renders in an
// <iframe> (the browser's out-of-process viewer — a malicious PDF can't reach
// this page), images/audio/video use the native elements, and office/text files
// offer "Open original" (download) rather than an in-app office renderer. The
// bytes are served by the ownership-gated proxy, which stamps a `sandbox` CSP on
// the response, so the embedded document is sandboxed by the server too.

"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useState } from "react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/shadcn/tabs";
import { type AssetKind, isDocumentKind } from "@/lib/domain/multimedia";
import { ASSET_KIND_META } from "./assetKindMeta";
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
			<header className="flex items-center justify-between border-b border-nova-border px-4 py-3">
				<Dialog.Title className="flex min-w-0 items-center gap-2 text-base font-display font-semibold text-nova-text">
					<Icon
						icon={ASSET_KIND_META[target.kind].icon}
						className="size-4 shrink-0 text-nova-text-muted"
					/>
					<span className="truncate">{name}</span>
				</Dialog.Title>
				<Dialog.Close
					className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</Dialog.Close>
			</header>

			{isDocument ? (
				<Tabs defaultValue="document" className="min-h-0 flex-1 gap-0 p-4 pt-3">
					<TabsList variant="line" className="mb-3">
						<TabsTrigger value="document">Document</TabsTrigger>
						<TabsTrigger value="extract">What the AI reads</TabsTrigger>
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

/** The raw-file view, dispatched by kind. */
function DocumentView({ target }: { target: AssetPreviewTarget }) {
	const src = mediaSrc(target.id);
	const name = target.filename;
	switch (target.kind) {
		case "image":
			return (
				// biome-ignore lint/performance/noImgElement: the proxy route is session-authed; next/image can't carry the cookie auth
				<img
					src={src}
					alt={name}
					className="mx-auto max-h-[65vh] rounded-md object-contain"
				/>
			);
		case "audio":
			// biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track
			return <audio controls src={src} className="w-full" />;
		case "video":
			// biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track
			return <video controls src={src} className="max-h-[65vh] w-full" />;
		case "pdf":
			// The browser's native PDF viewer renders out-of-process; the proxy's
			// `sandbox` CSP sandboxes the document as defense-in-depth.
			return (
				<iframe
					src={src}
					title={name}
					className="h-[65vh] w-full rounded-md border border-nova-border bg-white"
				/>
			);
		default:
			// docx / xlsx / text — no in-app office renderer (by design); open the
			// original file in a new tab (the browser downloads or renders it).
			return <OpenOriginal src={src} kind={target.kind} />;
	}
}

/** Fallback for documents Nova doesn't render in-app: a clean "open original". */
function OpenOriginal({ src, kind }: { src: string; kind: AssetKind }) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-nova-border px-6 py-12 text-center">
			<Icon
				icon={ASSET_KIND_META[kind].icon}
				className="size-10 text-nova-text-muted"
			/>
			<p className="text-sm text-nova-text-secondary">
				{ASSET_KIND_META[kind].label} files open in a new tab. Switch to{" "}
				<span className="text-nova-text">What the AI reads</span> to see what
				the assistant extracted.
			</p>
			<a
				href={src}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1.5 rounded-md bg-nova-violet px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nova-violet-bright"
			>
				<Icon icon={tablerExternalLink} className="size-4" />
				Open original
			</a>
		</div>
	);
}

type ExtractState =
	| { state: "loading" }
	| { state: "ready"; text: string }
	| { state: "absent" }
	| { state: "error"; message: string };

/** The "What the AI reads" panel — fetches the stored extract for the document. */
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
				Loading what the assistant reads…
			</p>
		);
	}
	if (extract.state === "absent") {
		return (
			<p className="py-8 text-center text-sm text-nova-text-muted">
				This document hasn't been read yet. Once feature extraction finishes,
				its extract appears here.
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
