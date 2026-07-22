/**
 * Upload to CommCare HQ dialog — modal for uploading the current app
 * as a new CommCare application to one of the user's project spaces.
 *
 * Uses Base UI Dialog for accessible dismiss/focus coordination via
 * FloatingTreeStore. An HQ API key can reach several project spaces, and THIS
 * dialog is where the upload target is chosen (the Settings card is
 * display-only): a single-space key shows a static verified card; a
 * multi-space key shows a picker (the shadcn `Select`, Base-UI-backed) that
 * starts unselected — there is no stored default, so the target is chosen here
 * per upload. The selected space is sent to the upload route, which
 * re-authorizes it against the key's reachable set.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useReconcilerContext } from "@/lib/collab/context";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAccessPhase } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { describeApiFailure } from "@/lib/ui/apiFailure";

// ── Types ──────────────────────────────────────────────────────────

/** A project space the key can upload to. */
type Domain = { name: string; displayName: string };

interface UploadToHqDialogProps {
	open: boolean;
	onClose: () => void;
	/** The app id to upload. The server loads the blueprint and converts it
	 *  to CommCare's wire format at the upload boundary — no whole doc on the
	 *  wire. Called when the user clicks Upload. */
	getAppId: () => string;
	/** Every space the key can upload to. Empty ⇒ HQ not configured. */
	availableDomains: Domain[];
}

/** Upload status — independent of the form fields. */
type UploadStatus =
	| { type: "idle" }
	| { type: "uploading" }
	| { type: "success"; appUrl: string; warnings: string[] }
	| {
			type: "error";
			message: string;
			status: number;
			/** Per-issue lines from the boundary gate (each names what's wrong
			 *  and where it lives). Empty for non-gate failures. */
			details: string[];
	  };

// ── Component ──────────────────────────────────────────────────────

export function UploadToHqDialog({
	open,
	onClose,
	getAppId,
	availableDomains,
}: UploadToHqDialogProps) {
	const accessPhase = useAccessPhase();
	const session = useBuilderSessionApi();
	const reconciler = useReconcilerContext();
	const uploadControllerRef = useRef<AbortController | null>(null);
	/* Self-subscribe to the app name from the doc store — no prop drilling
	 * from BuilderLayout needed. Only re-renders when appName actually changes. */
	const storeAppName = useAppName();
	const [uploadStatus, setUploadStatus] = useState<UploadStatus>({
		type: "idle",
	});
	const [appName, setAppName] = useState(storeAppName);
	/* The chosen target space (a domain slug). Seeded on open. */
	const [selectedDomain, setSelectedDomain] = useState("");
	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				uploadControllerRef.current?.abort();
				uploadControllerRef.current = null;
				setUploadStatus({ type: "idle" });
				onClose();
			}),
		[onClose, reconciler],
	);
	useEffect(() => {
		if (open) return;
		uploadControllerRef.current?.abort();
		uploadControllerRef.current = null;
	}, [open]);
	useEffect(
		() => () => {
			uploadControllerRef.current?.abort();
			uploadControllerRef.current = null;
		},
		[],
	);

	const notConfigured = availableDomains.length === 0;
	const isMultiSpace = availableDomains.length > 1;

	/* Base UI Select resolves the trigger label from `items` (value → label),
	 * so the closed trigger shows the friendly displayName rather than the raw
	 * slug — no per-render formatter needed. */
	const domainItems = useMemo(
		() =>
			availableDomains.map((d) => ({ label: d.displayName, value: d.name })),
		[availableDomains],
	);

	/* ── Reset form state on the open (false→true) transition only ──── */
	/* Seeding only on open — not on every dep change — means a prop or
	 * store update while the dialog is open (a refreshed app name, a settings
	 * change elsewhere) can't clobber the name the user is typing or the space
	 * they just picked. The deps are still listed for lint correctness; the
	 * `justOpened` guard is what scopes the reset to the transition. */
	const wasOpenRef = useRef(false);
	useEffect(() => {
		const justOpened = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!justOpened) return;
		setUploadStatus({ type: "idle" });
		setAppName(storeAppName);
		/* Seed the picker: a single-space key has exactly one choice; a
		 * multi-space key starts unselected (there is no stored default), gating
		 * Upload until the user picks a target. */
		setSelectedDomain(
			availableDomains.length === 1 ? availableDomains[0].name : "",
		);
	}, [open, storeAppName, availableDomains]);

	/* ── Upload handler ────────────────────────────────────────────── */
	const handleUpload = useCallback(async () => {
		if (!selectedDomain || !appName.trim()) return;
		const start = session.getState();
		if (start.accessPhase !== "authorized") return;
		const uploadScopeEpoch = start.scopeEpoch;
		const isCurrent = () => {
			const current = session.getState();
			return (
				current.accessPhase === "authorized" &&
				current.scopeEpoch === uploadScopeEpoch
			);
		};
		uploadControllerRef.current?.abort();
		const controller = new AbortController();
		uploadControllerRef.current = controller;

		setUploadStatus({ type: "uploading" });

		try {
			const res = await fetch("/api/commcare/upload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: selectedDomain,
					appName: appName.trim(),
					appId: getAppId(),
				}),
				signal: controller.signal,
			});
			if (!isCurrent()) {
				void res.body?.cancel();
				return;
			}

			const data = (await res.json()) as {
				success?: boolean;
				appUrl?: string;
				warnings?: string[];
				error?: string;
			};
			if (!isCurrent()) return;

			if (!res.ok || !data.success) {
				const failure = describeApiFailure(
					data,
					`Upload failed (HTTP ${res.status})`,
				);
				setUploadStatus({
					type: "error",
					message: failure.message,
					status: res.status,
					details: failure.details,
				});
				return;
			}

			setUploadStatus({
				type: "success",
				appUrl: data.appUrl ?? "",
				warnings: data.warnings ?? [],
			});
		} catch (error) {
			if (
				controller.signal.aborted ||
				!isCurrent() ||
				(error instanceof DOMException && error.name === "AbortError")
			)
				return;
			setUploadStatus({
				type: "error",
				message: "Network error. Please check your connection and try again.",
				status: 0,
				details: [],
			});
		} finally {
			if (uploadControllerRef.current === controller) {
				uploadControllerRef.current = null;
			}
		}
	}, [selectedDomain, appName, getAppId, session]);

	const isUploading = uploadStatus.type === "uploading";
	const canUpload =
		!notConfigured &&
		!!selectedDomain &&
		!isUploading &&
		appName.trim().length > 0;

	if (accessPhase !== "authorized") return null;

	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<DialogContent className="gap-0 p-0">
				{/* ── Header ───────────────────────────────────── */}
				<div className="px-5 pt-5">
					<DialogTitle className="font-display">
						Upload to CommCare HQ
					</DialogTitle>
				</div>

				{/* ── Body ─────────────────────────────────────── */}
				<div className="px-5 py-4">
					{uploadStatus.type === "success" ? (
						<SuccessView
							appUrl={uploadStatus.appUrl}
							warnings={uploadStatus.warnings}
							onClose={onClose}
						/>
					) : notConfigured ? (
						<LoadErrorView
							message="CommCare HQ is not configured. Add your API key in Settings."
							onClose={onClose}
						/>
					) : (
						<>
							<div className="space-y-4">
								{/* Project space — picker (multi) or verified badge (single) */}
								<div className="flex flex-col gap-1.5">
									<span className="text-sm text-nova-text-secondary font-medium">
										Project Space
									</span>
									{isMultiSpace ? (
										<>
											<Select
												items={domainItems}
												value={selectedDomain}
												onValueChange={(next) => setSelectedDomain(next ?? "")}
												disabled={isUploading}
											>
												<SelectTrigger
													className="w-full"
													aria-label="Project space"
												>
													<SelectValue placeholder="Choose a project space…" />
												</SelectTrigger>
												<SelectContent>
													{availableDomains.map((d) => (
														<SelectItem key={d.name} value={d.name}>
															{d.displayName}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											{selectedDomain && (
												<span className="text-[11px] text-nova-text-muted">
													Uploads to {selectedDomain}
												</span>
											)}
										</>
									) : (
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
													{availableDomains[0].displayName}
												</p>
												<p className="text-[11px] text-nova-text-muted leading-snug">
													{availableDomains[0].name}
												</p>
											</div>
										</div>
									)}
								</div>

								{/* App name input */}
								<label
									htmlFor="hq-upload-app-name"
									className="flex flex-col gap-1.5"
								>
									<span className="text-sm text-nova-text-secondary font-medium">
										App Name
									</span>
									<Input
										id="hq-upload-app-name"
										type="text"
										value={appName}
										onChange={(e) => setAppName(e.target.value)}
										disabled={isUploading}
										autoComplete="off"
										data-1p-ignore
										className="h-auto px-4 py-2.5"
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
										Creates a new app in the selected project space. Does not
										update existing apps.
									</p>
								</div>
							</div>

							{/* Upload error — inline, form stays intact for retry.
							 * Boundary-gate rejections carry per-issue lines, each
							 * naming what's wrong and where — list them so the user
							 * can fix the app without guessing. */}
							{uploadStatus.type === "error" && (
								<div className="mt-3">
									<p className="text-sm text-nova-rose">
										{uploadStatus.message}
									</p>
									{uploadStatus.details.length > 0 && (
										<ul className="mt-1.5 space-y-1 list-disc pl-4">
											{uploadStatus.details.map((line) => (
												<li
													key={line}
													className="text-xs text-nova-text-secondary leading-snug"
												>
													{line}
												</li>
											))}
										</ul>
									)}
									{uploadStatus.status === 401 && (
										<Link
											href="/settings"
											onClick={onClose}
											className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium text-nova-violet-bright hover:text-white transition-colors"
										>
											Go to Settings
											<Icon icon={tablerChevronRight} width="12" height="12" />
										</Link>
									)}
								</div>
							)}

							{/* Action buttons */}
							<div className="mt-5 flex justify-end gap-2">
								<DialogClose render={<Button variant="outline" size="lg" />}>
									Cancel
								</DialogClose>
								<Button
									type="button"
									size="lg"
									onClick={handleUpload}
									disabled={!canUpload}
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
								</Button>
							</div>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
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
				<Button type="button" variant="outline" size="lg" onClick={onClose}>
					Done
				</Button>
			</div>
		</div>
	);
}

/** Load error view — shown when no spaces are reachable (settings not configured). */
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
					className="inline-flex items-center gap-1 text-sm font-medium text-nova-violet-bright hover:text-white transition-colors"
				>
					Go to Settings
					<Icon icon={tablerChevronRight} width="14" height="14" />
				</Link>
				<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
			</div>
		</div>
	);
}
