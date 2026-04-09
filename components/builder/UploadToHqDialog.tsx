/**
 * Upload to CommCare HQ dialog — modal for selecting a project space
 * and uploading the current app as a new CommCare application.
 *
 * Domains and upload status are independent state — a failed upload
 * never wipes the form. The user can change their selection and retry
 * without re-fetching anything.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

// ── Types ──────────────────────────────────────────────────────────

interface UploadToHqDialogProps {
	open: boolean;
	onClose: () => void;
	/** Retrieves the current blueprint for upload. Called when the user clicks Upload. */
	getBlueprint: () => AppBlueprint;
	/** The app name from the builder (pre-fills the name field). */
	appName: string;
}

interface Domain {
	name: string;
	displayName: string;
}

/** Upload status — independent of the domains list. */
type UploadStatus =
	| { type: "idle" }
	| { type: "uploading" }
	| { type: "success"; appUrl: string; warnings: string[] }
	| { type: "error"; message: string; status: number };

// ── Component ──────────────────────────────────────────────────────

export function UploadToHqDialog({
	open,
	onClose,
	getBlueprint,
	appName: initialAppName,
}: UploadToHqDialogProps) {
	/* Domains and upload status are separate — a failed upload never wipes the form. */
	const [domains, setDomains] = useState<Domain[]>([]);
	const [domainsLoading, setDomainsLoading] = useState(true);
	const [domainsError, setDomainsError] = useState<string | null>(null);
	const [uploadStatus, setUploadStatus] = useState<UploadStatus>({
		type: "idle",
	});

	const [selectedDomain, setSelectedDomain] = useState("");
	const [appName, setAppName] = useState(initialAppName);
	const cancelRef = useRef(onClose);
	cancelRef.current = onClose;

	/* ── Fetch domains when dialog opens ───────────────────────────── */
	useEffect(() => {
		if (!open) return;

		/* Reset for fresh open. */
		setDomainsLoading(true);
		setDomainsError(null);
		setDomains([]);
		setUploadStatus({ type: "idle" });
		setSelectedDomain("");
		setAppName(initialAppName);

		const controller = new AbortController();
		fetch("/api/commcare/domains", { signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					setDomainsError(
						data.error ?? `Failed to load project spaces (HTTP ${res.status})`,
					);
					return;
				}
				const data = (await res.json()) as { domains: Domain[] };
				setDomains(data.domains);
			})
			.catch((err) => {
				if (err instanceof DOMException && err.name === "AbortError") return;
				setDomainsError("Failed to connect to CommCare HQ.");
			})
			.finally(() => setDomainsLoading(false));

		return () => controller.abort();
	}, [open, initialAppName]);

	/* ── Escape key dismissal ──────────────────────────────────────── */
	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") cancelRef.current();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open]);

	/* ── Upload handler ────────────────────────────────────────────── */
	const handleUpload = useCallback(async () => {
		if (!selectedDomain || !appName.trim()) return;

		setUploadStatus({ type: "uploading" });

		try {
			const blueprint = getBlueprint();
			const res = await fetch("/api/commcare/upload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: selectedDomain,
					appName: appName.trim(),
					blueprint,
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
	}, [selectedDomain, appName, getBlueprint]);

	const isUploading = uploadStatus.type === "uploading";
	const canUpload =
		!domainsLoading &&
		!domainsError &&
		!isUploading &&
		selectedDomain !== "" &&
		appName.trim().length > 0;

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					className="fixed inset-0 z-popover flex items-center justify-center"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.15 }}
				>
					{/* ── Backdrop ──────────────────────────────────────── */}
					<button
						type="button"
						className="absolute inset-0 bg-black/60 cursor-default appearance-none border-none p-0"
						onClick={onClose}
						tabIndex={-1}
						aria-label="Close dialog"
					/>

					{/* ── Dialog panel ──────────────────────────────────── */}
					<motion.div
						role="dialog"
						aria-modal="true"
						aria-label="Upload to CommCare HQ"
						className="relative z-10 w-full max-w-md rounded-xl bg-nova-deep border border-nova-border shadow-xl"
						initial={{ scale: 0.95, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.95, opacity: 0 }}
						transition={{ duration: 0.15 }}
					>
						{/* ── Header ───────────────────────────────────── */}
						<div className="flex items-center justify-between px-5 pt-5 pb-0">
							<h2 className="text-base font-display font-semibold text-nova-text">
								Upload to CommCare HQ
							</h2>
							<button
								type="button"
								onClick={onClose}
								className="p-1 rounded-lg text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
								aria-label="Close"
							>
								<Icon icon={tablerX} width="16" height="16" />
							</button>
						</div>

						{/* ── Body ─────────────────────────────────────── */}
						<div className="px-5 py-4">
							{uploadStatus.type === "success" ? (
								<SuccessView
									appUrl={uploadStatus.appUrl}
									warnings={uploadStatus.warnings}
									onClose={onClose}
								/>
							) : domainsError && domains.length === 0 ? (
								<LoadErrorView message={domainsError} onClose={onClose} />
							) : (
								<>
									<div className="space-y-4">
										{/* Project space selector */}
										<label
											htmlFor="hq-domain-select"
											className="flex flex-col gap-1.5"
										>
											<span className="text-sm text-nova-text-secondary font-medium">
												Project Space
											</span>
											<div className="relative">
												{domainsLoading ? (
													<div className="w-full px-4 py-2.5 bg-nova-deep border border-nova-border rounded-lg flex items-center gap-2 text-sm text-nova-text-muted">
														<Icon
															icon={tablerLoader2}
															width="14"
															height="14"
															className="animate-spin"
														/>
														Loading project spaces...
													</div>
												) : (
													<>
														<select
															id="hq-domain-select"
															value={selectedDomain}
															onChange={(e) =>
																setSelectedDomain(e.target.value)
															}
															disabled={isUploading}
															className="w-full px-4 py-2.5 pr-9 bg-nova-deep border border-nova-border rounded-lg text-nova-text appearance-none focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all duration-200 disabled:opacity-50 cursor-pointer"
														>
															<option value="" disabled>
																Select a project space
															</option>
															{domains.map((d) => (
																<option key={d.name} value={d.name}>
																	{d.displayName}
																</option>
															))}
														</select>
														<Icon
															icon={tablerChevronDown}
															width="14"
															height="14"
															className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-nova-text-muted"
														/>
													</>
												)}
											</div>
										</label>

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
												Creates a new app in the selected project space. Does
												not update existing apps.
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
										<button
											type="button"
											onClick={onClose}
											disabled={isUploading}
											className="px-4 py-2 text-sm font-medium rounded-lg border border-nova-border text-nova-text-secondary hover:text-nova-text transition-colors cursor-pointer disabled:opacity-50"
										>
											Cancel
										</button>
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
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
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

/** Load error view — shown when domains can't be fetched at all. */
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
			<div className="flex justify-end">
				<button
					type="button"
					onClick={onClose}
					className="px-4 py-2 text-sm font-medium rounded-lg border border-nova-border text-nova-text-secondary hover:text-nova-text transition-colors cursor-pointer"
				>
					Close
				</button>
			</div>
		</div>
	);
}
