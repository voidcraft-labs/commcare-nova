/**
 * Unified publish flow for direct HQ upload, HQ JSON, and mobile CCZ.
 *
 * All three destinations stay in one durable modal because publish results can
 * carry important follow-up information. A dropdown disappears at selection;
 * this dialog can explain confirmed-missing flags after a direct upload and
 * unverified requirements after a file download without relying on a toast.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerBrowser from "@iconify-icons/tabler/browser";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerDeviceMobile from "@iconify-icons/tabler/device-mobile";
import tablerDownload from "@iconify-icons/tabler/download";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
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
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/shadcn/tabs";
import { useReconcilerContext } from "@/lib/collab/context";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import type { HqFeatureFlagReport } from "@/lib/publish/hqFeatureFlags";
import { useAccessPhase, useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { describeApiFailure } from "@/lib/ui/apiFailure";

type Domain = { name: string; displayName: string };
type PublishTarget = "hq" | "web" | "mobile";

export type PublishDownloadOutcome =
	| { readonly ok: true; readonly featureFlagReport?: HqFeatureFlagReport }
	| { readonly ok: false };

interface PublishDialogProps {
	open: boolean;
	onClose: () => void;
	getAppId: () => string;
	availableDomains: Domain[];
	canUploadToHq: boolean;
	onDownloadJson: () => Promise<PublishDownloadOutcome>;
	onDownloadCcz: () => Promise<PublishDownloadOutcome>;
}

type PublishStatus =
	| { type: "idle" }
	| { type: "uploading" }
	| { type: "downloading"; target: "web" | "mobile" }
	| {
			type: "upload-success";
			appUrl: string;
			warnings: string[];
			featureFlagReport?: HqFeatureFlagReport;
	  }
	| {
			type: "download-success";
			target: "web" | "mobile";
			featureFlagReport?: HqFeatureFlagReport;
	  }
	| { type: "error"; message: string; status: number; details: string[] };

export function PublishDialog({
	open,
	onClose,
	getAppId,
	availableDomains,
	canUploadToHq,
	onDownloadJson,
	onDownloadCcz,
}: PublishDialogProps) {
	const accessPhase = useAccessPhase();
	const canEdit = useCanEdit();
	const session = useBuilderSessionApi();
	const reconciler = useReconcilerContext();
	const uploadControllerRef = useRef<AbortController | null>(null);
	const operationGenerationRef = useRef(0);
	const storeAppName = useAppName();
	const [target, setTarget] = useState<PublishTarget>(
		canUploadToHq ? "hq" : "web",
	);
	const [status, setStatus] = useState<PublishStatus>({ type: "idle" });
	const [appName, setAppName] = useState(storeAppName);
	const [selectedDomain, setSelectedDomain] = useState("");
	const handleClose = useCallback(() => {
		operationGenerationRef.current += 1;
		uploadControllerRef.current?.abort();
		uploadControllerRef.current = null;
		onClose();
	}, [onClose]);

	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				setStatus({ type: "idle" });
				handleClose();
			}),
		[handleClose, reconciler],
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
	const domainItems = useMemo(
		() =>
			availableDomains.map((domain) => ({
				label: domain.displayName,
				value: domain.name,
			})),
		[availableDomains],
	);

	const wasOpenRef = useRef(false);
	useEffect(() => {
		const justOpened = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!justOpened) return;
		operationGenerationRef.current += 1;
		setStatus({ type: "idle" });
		setTarget(canUploadToHq ? "hq" : "web");
		setAppName(storeAppName);
		setSelectedDomain(
			availableDomains.length === 1 ? availableDomains[0].name : "",
		);
	}, [open, storeAppName, availableDomains, canUploadToHq]);

	const handleTargetChange = useCallback((next: PublishTarget) => {
		operationGenerationRef.current += 1;
		setTarget(next);
		setStatus({ type: "idle" });
	}, []);

	const handleUpload = useCallback(async () => {
		if (!selectedDomain || !appName.trim()) return;
		const generation = ++operationGenerationRef.current;
		const start = session.getState();
		if (start.accessPhase !== "authorized" || !start.canEdit) return;
		const uploadScopeEpoch = start.scopeEpoch;
		const isCurrent = () => {
			const current = session.getState();
			return (
				operationGenerationRef.current === generation &&
				current.accessPhase === "authorized" &&
				current.canEdit &&
				current.scopeEpoch === uploadScopeEpoch
			);
		};
		uploadControllerRef.current?.abort();
		const controller = new AbortController();
		uploadControllerRef.current = controller;
		setStatus({ type: "uploading" });

		try {
			const response = await fetch("/api/commcare/upload", {
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
				void response.body?.cancel();
				return;
			}
			const data = (await response.json()) as {
				success?: boolean;
				appUrl?: string;
				warnings?: string[];
				feature_flag_requirements?: HqFeatureFlagReport;
				error?: string;
			};
			if (!isCurrent()) return;
			if (!response.ok || !data.success) {
				const failure = describeApiFailure(
					data,
					`Upload failed (HTTP ${response.status})`,
				);
				setStatus({
					type: "error",
					message: failure.message,
					status: response.status,
					details: failure.details,
				});
				return;
			}
			setStatus({
				type: "upload-success",
				appUrl: data.appUrl ?? "",
				warnings: data.warnings ?? [],
				featureFlagReport: data.feature_flag_requirements,
			});
		} catch (error) {
			if (
				controller.signal.aborted ||
				!isCurrent() ||
				(error instanceof DOMException && error.name === "AbortError")
			)
				return;
			setStatus({
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

	const handleDownload = useCallback(
		async (downloadTarget: "web" | "mobile") => {
			const generation = ++operationGenerationRef.current;
			setStatus({ type: "downloading", target: downloadTarget });
			const outcome = await (downloadTarget === "web"
				? onDownloadJson()
				: onDownloadCcz());
			if (operationGenerationRef.current !== generation) return;
			if (!outcome.ok) {
				setStatus({ type: "idle" });
				return;
			}
			setStatus({
				type: "download-success",
				target: downloadTarget,
				featureFlagReport: outcome.featureFlagReport,
			});
		},
		[onDownloadCcz, onDownloadJson],
	);

	const isWorking =
		status.type === "uploading" || status.type === "downloading";
	const canUpload =
		canEdit &&
		canUploadToHq &&
		!notConfigured &&
		!!selectedDomain &&
		!isWorking &&
		appName.trim().length > 0;

	if (accessPhase !== "authorized") return null;

	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
			<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
				<div className="border-b border-nova-border px-5 pb-3 pt-5">
					<DialogTitle className="font-display tracking-tighter">
						Publish app
					</DialogTitle>
					<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
						Upload directly or download a file for another destination.
					</p>
				</div>

				<Tabs
					value={target}
					onValueChange={(value) => handleTargetChange(value as PublishTarget)}
					className="min-h-0 flex-1 gap-0"
				>
					<div className="shrink-0 border-b border-nova-border px-5">
						<TabsList variant="line" className="h-12 w-full">
							{canUploadToHq && (
								<TabsTrigger value="hq" disabled={isWorking}>
									<Icon icon={tablerCloudUpload} className="size-4" />
									CommCare HQ
								</TabsTrigger>
							)}
							<TabsTrigger value="web" disabled={isWorking}>
								<Icon icon={tablerBrowser} className="size-4" />
								Web
							</TabsTrigger>
							<TabsTrigger value="mobile" disabled={isWorking}>
								<Icon icon={tablerDeviceMobile} className="size-4" />
								Mobile
							</TabsTrigger>
						</TabsList>
					</div>

					<DialogBody className="mx-0 px-0">
						{canUploadToHq && (
							<TabsContent value="hq" className="px-5 py-4">
								{status.type === "upload-success" ? (
									<PublishSuccess
										title="App uploaded successfully"
										appUrl={status.appUrl}
										warnings={status.warnings}
										featureFlagReport={status.featureFlagReport}
										mode="upload"
										onClose={handleClose}
									/>
								) : notConfigured ? (
									<NotConfigured onClose={handleClose} />
								) : (
									<UploadForm
										availableDomains={availableDomains}
										domainItems={domainItems}
										isMultiSpace={isMultiSpace}
										selectedDomain={selectedDomain}
										onSelectedDomainChange={setSelectedDomain}
										appName={appName}
										onAppNameChange={setAppName}
										status={status}
										canUpload={canUpload}
										onUpload={handleUpload}
									/>
								)}
							</TabsContent>
						)}

						<TabsContent value="web" className="px-5 py-4">
							{status.type === "download-success" && status.target === "web" ? (
								<PublishSuccess
									title="Web app file downloaded"
									featureFlagReport={status.featureFlagReport}
									mode="download"
									onClose={handleClose}
								/>
							) : (
								<DownloadForm
									title="CommCare HQ app file"
									description="Download JSON to import into CommCare HQ yourself. Apps with media download as a ZIP with import instructions."
									buttonLabel="Download JSON"
									working={
										status.type === "downloading" && status.target === "web"
									}
									onDownload={() => handleDownload("web")}
								/>
							)}
						</TabsContent>

						<TabsContent value="mobile" className="px-5 py-4">
							{status.type === "download-success" &&
							status.target === "mobile" ? (
								<PublishSuccess
									title="Mobile app file downloaded"
									featureFlagReport={status.featureFlagReport}
									mode="download"
									onClose={handleClose}
								/>
							) : (
								<DownloadForm
									title="CommCare mobile app file"
									description="Download a CCZ package for CommCare Android or another mobile deployment workflow."
									buttonLabel="Download CCZ"
									working={
										status.type === "downloading" && status.target === "mobile"
									}
									onDownload={() => handleDownload("mobile")}
								/>
							)}
						</TabsContent>
					</DialogBody>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function UploadForm({
	availableDomains,
	domainItems,
	isMultiSpace,
	selectedDomain,
	onSelectedDomainChange,
	appName,
	onAppNameChange,
	status,
	canUpload,
	onUpload,
}: {
	availableDomains: Domain[];
	domainItems: { label: string; value: string }[];
	isMultiSpace: boolean;
	selectedDomain: string;
	onSelectedDomainChange: (value: string) => void;
	appName: string;
	onAppNameChange: (value: string) => void;
	status: PublishStatus;
	canUpload: boolean;
	onUpload: () => void;
}) {
	const uploading = status.type === "uploading";
	return (
		<>
			<div className="space-y-4">
				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium text-nova-text-secondary">
						Project space
					</span>
					{isMultiSpace ? (
						<>
							<Select
								items={domainItems}
								value={selectedDomain}
								onValueChange={(next) => onSelectedDomainChange(next ?? "")}
								disabled={uploading}
							>
								<SelectTrigger className="w-full" aria-label="Project space">
									<SelectValue placeholder="Choose a project space" />
								</SelectTrigger>
								<SelectContent>
									{availableDomains.map((domain) => (
										<SelectItem key={domain.name} value={domain.name}>
											{domain.displayName}
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
						<div className="flex items-center gap-3 rounded-lg border border-nova-emerald/15 bg-nova-emerald/[0.04] px-3.5 py-2.5">
							<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-nova-emerald/10">
								<Icon
									icon={tablerCircleCheck}
									className="size-4 text-nova-emerald"
								/>
							</div>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium leading-snug text-nova-text">
									{availableDomains[0].displayName}
								</p>
								<p className="text-[11px] leading-snug text-nova-text-muted">
									{availableDomains[0].name}
								</p>
							</div>
						</div>
					)}
				</div>

				<label htmlFor="hq-upload-app-name" className="flex flex-col gap-1.5">
					<span className="text-sm font-medium text-nova-text-secondary">
						App name
					</span>
					<Input
						id="hq-upload-app-name"
						type="text"
						value={appName}
						onChange={(event) => onAppNameChange(event.target.value)}
						disabled={uploading}
						autoComplete="off"
						data-1p-ignore
						className="h-auto px-4 py-2.5"
					/>
				</label>

				<div className="flex items-start gap-2 rounded-lg border border-white/[0.04] bg-white/[0.03] px-3 py-2.5">
					<Icon
						icon={tablerInfoCircle}
						className="mt-0.5 size-4 shrink-0 text-nova-text-muted"
					/>
					<p className="text-xs leading-relaxed text-nova-text-muted">
						Creates a new app in the selected project space. After upload, Nova
						checks the HQ feature flags this app needs.
					</p>
				</div>
			</div>

			{status.type === "error" && (
				<div className="mt-3">
					<p className="text-sm text-nova-rose">{status.message}</p>
					{status.details.length > 0 && (
						<ul className="mt-1.5 list-disc space-y-1 pl-4">
							{status.details.map((line) => (
								<li
									key={line}
									className="text-xs leading-snug text-nova-text-secondary"
								>
									{line}
								</li>
							))}
						</ul>
					)}
					{status.status === 401 && (
						<Link
							href="/settings"
							className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-nova-violet-bright transition-colors hover:text-nova-text"
						>
							Go to Settings
							<Icon icon={tablerChevronRight} className="size-3" />
						</Link>
					)}
				</div>
			)}

			<div className="mt-5 flex justify-end gap-2">
				<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
				<Button type="button" onClick={onUpload} disabled={!canUpload}>
					{uploading ? (
						<>
							<Icon icon={tablerLoader2} className="size-4 animate-spin" />
							Uploading...
						</>
					) : (
						"Upload"
					)}
				</Button>
			</div>
		</>
	);
}

function DownloadForm({
	title,
	description,
	buttonLabel,
	working,
	onDownload,
}: {
	title: string;
	description: string;
	buttonLabel: string;
	working: boolean;
	onDownload: () => void;
}) {
	return (
		<div>
			<h3 className="text-sm font-semibold text-nova-text">{title}</h3>
			<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
				{description}
			</p>
			<div className="mt-4 flex items-start gap-2 rounded-lg border border-white/[0.04] bg-white/[0.03] px-3 py-2.5">
				<Icon
					icon={tablerInfoCircle}
					className="mt-0.5 size-4 shrink-0 text-nova-text-muted"
				/>
				<p className="text-xs leading-relaxed text-nova-text-muted">
					A downloaded file has no connected destination for Nova to check.
					After the download, this dialog will list any feature flags the
					destination project space needs.
				</p>
			</div>
			<div className="mt-5 flex justify-end gap-2">
				<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
				<Button type="button" onClick={onDownload} disabled={working}>
					{working ? (
						<>
							<Icon icon={tablerLoader2} className="size-4 animate-spin" />
							Preparing...
						</>
					) : (
						<>
							<Icon icon={tablerDownload} className="size-4" />
							{buttonLabel}
						</>
					)}
				</Button>
			</div>
		</div>
	);
}

function PublishSuccess({
	title,
	appUrl,
	warnings = [],
	featureFlagReport,
	mode,
	onClose,
}: {
	title: string;
	appUrl?: string;
	warnings?: string[];
	featureFlagReport?: HqFeatureFlagReport;
	mode: "upload" | "download";
	onClose: () => void;
}) {
	return (
		<div className="py-1">
			<div className="text-center">
				<motion.div
					initial={{ scale: 0 }}
					animate={{ scale: 1 }}
					transition={{ type: "spring", stiffness: 300, damping: 20 }}
					className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-nova-emerald/15"
				>
					<Icon icon={tablerCheck} className="size-6 text-nova-emerald" />
				</motion.div>
				<h3 className="text-sm font-semibold text-nova-text">{title}</h3>
			</div>

			{warnings.length > 0 && (
				<div className="mt-3 space-y-1 rounded-lg border border-nova-amber/20 bg-nova-amber/[0.06] px-3 py-2.5">
					{warnings.map((warning) => (
						<p
							key={warning}
							className="text-xs leading-relaxed text-nova-amber"
						>
							{warning}
						</p>
					))}
				</div>
			)}

			{featureFlagReport && (
				<FeatureFlagNotice report={featureFlagReport} mode={mode} />
			)}

			<div className="mt-5 flex items-center justify-between gap-3">
				{appUrl ? (
					<a
						href={appUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-sm text-nova-violet-bright hover:underline"
					>
						Open in CommCare HQ
						<Icon icon={tablerExternalLink} className="size-3.5" />
					</a>
				) : (
					<span />
				)}
				<Button type="button" variant="outline" onClick={onClose}>
					Done
				</Button>
			</div>
		</div>
	);
}

function FeatureFlagNotice({
	report,
	mode,
}: {
	report: HqFeatureFlagReport;
	mode: "upload" | "download";
}) {
	if (report.required_flags.length === 0) return null;
	const needsAttention =
		mode === "download" ||
		report.missing_flags.length > 0 ||
		report.unverified_flags.length > 0;
	if (!needsAttention) {
		const flagLabels = report.required_flags
			.map((flag) => flag.label)
			.join(", ");
		return (
			<div className="mt-3 flex items-start gap-2 rounded-lg border border-nova-emerald/15 bg-nova-emerald/[0.04] px-3 py-2.5">
				<Icon
					icon={tablerCircleCheck}
					className="mt-0.5 size-4 shrink-0 text-nova-emerald"
				/>
				<div>
					<p className="text-xs font-medium text-nova-text">
						Required feature flags verified
					</p>
					<p className="mt-0.5 text-xs leading-relaxed text-nova-text-muted">
						{flagLabels} {report.required_flags.length === 1 ? "is" : "are"}
						enabled for this project space.
					</p>
				</div>
			</div>
		);
	}

	const flags =
		mode === "download"
			? report.required_flags
			: [
					...report.missing_flags,
					...report.unverified_flags.filter(
						(flag) =>
							!report.missing_flags.some((missing) => missing.id === flag.id),
					),
				];
	return (
		<div className="mt-3 rounded-lg border border-nova-amber/20 bg-nova-amber/[0.06] px-3 py-3">
			<div className="flex items-start gap-2">
				<Icon
					icon={tablerInfoCircle}
					className="mt-0.5 size-4 shrink-0 text-nova-amber"
				/>
				<div className="min-w-0">
					<p className="text-xs font-semibold text-nova-text">
						{mode === "download"
							? "Required in the destination project space"
							: "CommCare HQ settings need attention"}
					</p>
					<p className="mt-1 text-xs leading-relaxed text-nova-text-secondary">
						{report.message}
					</p>
				</div>
			</div>
			<ul className="mt-2 space-y-2 pl-6">
				{flags.map((flag) => (
					<li key={flag.id} className="text-xs leading-relaxed">
						<div className="flex flex-wrap items-baseline gap-x-1.5">
							<span className="font-medium text-nova-text">{flag.label}</span>
							<code className="text-[11px] text-nova-text-muted">
								{flag.slug}
							</code>
							<a
								href={flag.docs_url}
								target="_blank"
								rel="noopener noreferrer"
								className="text-nova-violet-bright hover:underline"
							>
								Learn more
								<span className="sr-only"> about {flag.label}</span>
							</a>
						</div>
						<p className="text-nova-text-muted">{flag.description}</p>
					</li>
				))}
			</ul>
			<p className="mt-2 pl-6 text-xs text-nova-text-secondary">
				Contact{" "}
				<a
					href={`mailto:${report.support_email}`}
					className="text-nova-violet-bright hover:underline"
				>
					{report.support_email}
				</a>{" "}
				and include the project space name.
			</p>
		</div>
	);
}

function NotConfigured({ onClose }: { onClose: () => void }) {
	return (
		<div className="py-2">
			<p className="text-sm text-nova-rose">
				CommCare HQ is not configured. Add your API key in Settings.
			</p>
			<div className="mt-4 flex items-center justify-between">
				<Link
					href="/settings"
					onClick={onClose}
					className="inline-flex items-center gap-1 text-sm font-medium text-nova-violet-bright transition-colors hover:text-nova-text"
				>
					Go to Settings
					<Icon icon={tablerChevronRight} className="size-3.5" />
				</Link>
				<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
			</div>
		</div>
	);
}
