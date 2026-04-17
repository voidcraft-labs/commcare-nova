/**
 * Upload to CommCare HQ dialog — modal for uploading the current app
 * as a new CommCare application to the user's project space.
 *
 * Uses Base UI Dialog for accessible dismiss/focus coordination via
 * FloatingTreeStore. The domain is resolved from the user's stored
 * settings (an API key is scoped to exactly one domain) and shown as
 * static text — no selection needed.
 */

"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerX from "@iconify-icons/tabler/x";
import { motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { PersistableDoc } from "@/lib/domain";

// ── Types ──────────────────────────────────────────────────────────

interface UploadToHqDialogProps {
	open: boolean;
	onClose: () => void;
	/** Retrieves the persistable (on-disk) doc snapshot for upload.
	 *  Called when the user clicks Upload. The server converts the doc
	 *  to CommCare's wire format at the upload boundary. */
	getDoc: () => PersistableDoc;
	/** The user's authorized project space, resolved from settings on mount. */
	domain: { name: string; displayName: string } | null;
}

/** Upload status — independent of the form fields. */
type UploadStatus =
	| { type: "idle" }
	| { type: "uploading" }
	| { type: "success"; appUrl: string; warnings: string[] }
	| { type: "error"; message: string; status: number };

// ── Styles ─────────────────────────────────────────────────────────

/** Backdrop: semi-transparent black overlay with fade animation.
 *  z-modal ensures the backdrop covers all lower layers (toolbar, popovers). */
const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";

/** Dialog panel: centered card with scale + fade animation. */
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

// ── Component ──────────────────────────────────────────────────────

export function UploadToHqDialog({
	open,
	onClose,
	getDoc,
	domain,
}: UploadToHqDialogProps) {
	/* Self-subscribe to the app name from the doc store — no prop drilling
	 * from BuilderLayout needed. Only re-renders when appName actually changes. */
	const storeAppName = useBlueprintDoc((s) => s.appName);
	const [uploadStatus, setUploadStatus] = useState<UploadStatus>({
		type: "idle",
	});
	const [appName, setAppName] = useState(storeAppName);

	/* ── Reset form state when dialog opens ────────────────────────── */
	useEffect(() => {
		if (!open) return;
		setUploadStatus({ type: "idle" });
		setAppName(storeAppName);
	}, [open, storeAppName]);

	/* ── Upload handler ────────────────────────────────────────────── */
	const handleUpload = useCallback(async () => {
		if (!domain || !appName.trim()) return;

		setUploadStatus({ type: "uploading" });

		try {
			const doc = getDoc();
			const res = await fetch("/api/commcare/upload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: domain.name,
					appName: appName.trim(),
					doc,
				}),
			});

			const data = (await res.json()) as {
				success?: boolean;
				appUrl?: string;
				warnings?: string[];
				error?: string;
			};

			if (!res.ok || !data.success) {
				setUploadStatus({
					type: "error",
					message: data.error ?? `Upload failed (HTTP ${res.status})`,
					status: res.status,
				});
				return;
			}

			setUploadStatus({
				type: "success",
				appUrl: data.appUrl ?? "",
				warnings: data.warnings ?? [],
			});
		} catch {
			setUploadStatus({
				type: "error",
				message: "Network error. Please check your connection and try again.",
				status: 0,
			});
		}
	}, [domain, appName, getDoc]);

	const isUploading = uploadStatus.type === "uploading";
	const canUpload = !!domain && !isUploading && appName.trim().length > 0;

	return (
		<Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop className={BACKDROP_CLS} />
				<Dialog.Popup className={POPUP_CLS}>
					{/* ── Header ───────────────────────────────────── */}
					<div className="flex items-center justify-between px-5 pt-5 pb-0">
						<Dialog.Title className="text-base font-display font-semibold text-nova-text">
							Upload to CommCare HQ
						</Dialog.Title>
						<Dialog.Close className="p-1 rounded-lg text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer">
							<Icon icon={tablerX} width="16" height="16" />
						</Dialog.Close>
					</div>

					{/* ── Body ─────────────────────────────────────── */}
					<div className="px-5 py-4">
						{uploadStatus.type === "success" ? (
							<SuccessView
								appUrl={uploadStatus.appUrl}
								warnings={uploadStatus.warnings}
								onClose={onClose}
							/>
						) : !domain ? (
							<LoadErrorView
								message="CommCare HQ is not configured. Add your API key in Settings."
								onClose={onClose}
							/>
						) : (
							<>
								<div className="space-y-4">
									{/* Project space — verified badge, API key is scoped to one domain */}
									<div className="flex flex-col gap-1.5">
										<span className="text-sm text-nova-text-secondary font-medium">
											Project Space
										</span>
										<div className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg bg-nova-emerald/[0.04] border border-nova-emerald/15">
											<div className="flex items-center justify-center w-7 h-7 rounded-full bg-nova-emerald/10 shrink-0">
												<Icon
													icon={tablerCircleCheck}
													width="16"
													height="16"
													className="text-nova-emerald"
												/>
											</div>
											<div className="min-w-0">
												<p className="text-sm font-medium text-nova-text truncate leading-snug">
													{domain.displayName}
												</p>
												<p className="text-[11px] text-nova-text-muted leading-snug">
													{domain.name}
												</p>
											</div>
										</div>
									</div>

									{/* App name input */}
									<label className="flex flex-col gap-1.5">
										<span className="text-sm text-nova-text-secondary font-medium">
											App Name
										</span>
										<input
											type="text"
											value={appName}
											onChange={(e) => setAppName(e.target.value)}
											disabled={isUploading}
											autoComplete="off"
											data-1p-ignore
											className="w-full px-4 py-2.5 bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all duration-200 disabled:opacity-50"
										/>
									</label>

									{/* Info callout — sets expectations about new app creation */}
									<div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.04]">
										<Icon
											icon={tablerInfoCircle}
											width="15"
											height="15"
											className="text-nova-text-muted mt-0.5 shrink-0"
										/>
										<p className="text-xs text-nova-text-muted leading-relaxed">
											Creates a new app in your project space. Does not update
											existing apps.
										</p>
									</div>
								</div>

								{/* Upload error — inline, form stays intact for retry */}
								{uploadStatus.type === "error" && (
									<div className="mt-3">
										<p className="text-sm text-nova-rose">
											{uploadStatus.message}
										</p>
										{uploadStatus.status === 401 && (
											<Link
												href="/settings"
												onClick={onClose}
												className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium text-nova-violet-bright hover:text-nova-violet transition-colors"
											>
												Go to Settings
												<Icon
													icon={tablerChevronRight}
													width="12"
													height="12"
												/>
											</Link>
										)}
									</div>
								)}

								{/* Action buttons */}
								<div className="mt-5 flex justify-end gap-2">
									<Dialog.Close className="px-4 py-2 text-sm font-medium rounded-lg border border-nova-border text-nova-text-secondary hover:text-nova-text transition-colors cursor-pointer disabled:opacity-50">
										Cancel
									</Dialog.Close>
									<button
										type="button"
										onClick={handleUpload}
										disabled={!canUpload}
										className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium bg-nova-violet text-white hover:bg-nova-violet-bright transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
									>
										{isUploading ? (
											<>
												<Icon
													icon={tablerLoader2}
													width="15"
													height="15"
													className="animate-spin"
												/>
												Uploading...
											</>
										) : (
											"Upload"
										)}
									</button>
								</div>
							</>
						)}
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

// ── Sub-views ──────────────────────────────────────────────────────

/** Success view — checkmark, link to the new app, done button. */
function SuccessView({
	appUrl,
	warnings,
	onClose,
}: {
	appUrl: string;
	warnings: string[];
	onClose: () => void;
}) {
	return (
		<div className="text-center py-2">
			{/* Animated checkmark */}
			<motion.div
				initial={{ scale: 0 }}
				animate={{ scale: 1 }}
				transition={{ type: "spring", stiffness: 300, damping: 20 }}
				className="mx-auto w-12 h-12 rounded-full bg-nova-emerald/15 flex items-center justify-center mb-3"
			>
				<Icon
					icon={tablerCheck}
					width="24"
					height="24"
					className="text-nova-emerald"
				/>
			</motion.div>

			<h3 className="text-sm font-semibold text-nova-text mb-1">
				App uploaded successfully
			</h3>

			{warnings.length > 0 && (
				<div className="mt-2 mb-3 text-left">
					{warnings.map((w, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static warning list from API, no stable IDs
						<p key={i} className="text-xs text-nova-amber">
							{w}
						</p>
					))}
				</div>
			)}

			{appUrl && (
				<a
					href={appUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-sm text-nova-violet-bright hover:underline mt-1"
				>
					Open in CommCare HQ
					<Icon icon={tablerExternalLink} width="14" height="14" />
				</a>
			)}

			<div className="mt-5">
				<button
					type="button"
					onClick={onClose}
					className="px-5 py-2 rounded-lg text-sm font-medium border border-nova-border text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
				>
					Done
				</button>
			</div>
		</div>
	);
}

/** Load error view — shown when domain is missing (settings not configured). */
function LoadErrorView({
	message,
	onClose,
}: {
	message: string;
	onClose: () => void;
}) {
	return (
		<div className="py-2">
			<p className="text-sm text-nova-rose mb-4">{message}</p>
			<div className="flex items-center justify-between">
				<Link
					href="/settings"
					onClick={onClose}
					className="inline-flex items-center gap-1 text-sm font-medium text-nova-violet-bright hover:text-nova-violet transition-colors"
				>
					Go to Settings
					<Icon icon={tablerChevronRight} width="14" height="14" />
				</Link>
				<Dialog.Close className="px-4 py-2 text-sm font-medium rounded-lg border border-nova-border text-nova-text-secondary hover:text-nova-text transition-colors cursor-pointer">
					Close
				</Dialog.Close>
			</div>
		</div>
	);
}
