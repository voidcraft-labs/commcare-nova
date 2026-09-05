/**
 * PublishPanel: the self-contained flow for putting an app somewhere real.
 *
 * Owns the unified Publish dialog (HQ upload, JSON, or CCZ) and its open
 * state. Colocated so the trigger and
 * the dialog live in the same component: no state coordination through
 * BuilderLayout needed.
 *
 * The client-side surface speaks only the domain shape (`BlueprintDoc`).
 * Any domain → CommCare wire conversion happens server-side at the
 * compile / upload routes, which are the only legitimate external
 * emission boundaries.
 */
"use client";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
	memo,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useTransition,
} from "react";
import { useCommCareConnection } from "@/components/builder/CommCareConnectionContext";
import type {
	PublishDownloadOutcome,
	PublishProjectSpaceCompatibilityOutcome,
} from "@/components/builder/PublishDialog";
import { PublishButton } from "@/components/ui/PublishButton";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { CommCareServer } from "@/lib/deployment";
import { BlueprintDocContext } from "@/lib/doc/provider";
import {
	decodeExportAdvisories,
	EXPORT_ADVISORY_HEADER,
} from "@/lib/publish/exportAdvisories";
import {
	decodeProjectSpaceCompatibilityReport,
	PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER,
	type ProjectSpaceCompatibilityReport,
} from "@/lib/publish/projectSpaceCompatibility";
import { buildUrl } from "@/lib/routing/location";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import {
	useCanEdit,
	useClearPublishDialogRequest,
	usePublishDialogRequest,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { apiFailureToastBody, describeApiFailure } from "@/lib/ui/apiFailure";
import type { ToastOptions, ToastSeverity } from "@/lib/ui/toastStore";

const loadPublishDialog = () => import("@/components/builder/PublishDialog");
const PublishDialog = dynamic(() =>
	loadPublishDialog().then((module) => module.PublishDialog),
);

/**
 * Download a Blob under `filename` via a transient object URL. Centralizes the
 * create → click → revoke lifecycle both download handlers share so the revoke is
 * never forgotten: a leaked object URL pins the blob in memory.
 */
function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * POST a persistable doc to a compile endpoint and download the file it
 * returns. The two download choices differ only in endpoint, the failure-toast
 * noun, and how the filename's extension is derived from the response blob:
 * the request shape, the `res.ok` branch, the blob download, and the
 * network-failure toast are identical, so they live here once. Both endpoints
 * return the artifact bytes on success and JSON on failure, so we branch on
 * `res.ok` and never read the error body as a blob.
 *
 * A rejection reads its `{ error, details }` body and surfaces the actual
 * findings: the boundary gate's per-issue messages name what's wrong and
 * where, so the toast shows those lines rather than a generic "failed".
 */
async function downloadArtifact(opts: {
	appId: string;
	server?: CommCareServer;
	endpoint: string;
	/** Noun for the failure toast, e.g. `"the .ccz file"` / `"the JSON file"`. */
	fileLabel: string;
	/** Derive the download filename from the response blob (its MIME type may pick the extension). */
	filename: (blob: Blob) => string;
	signal: AbortSignal;
	isCurrent: () => boolean;
	toast: (
		severity: ToastSeverity,
		title: string,
		message?: string,
		options?: ToastOptions,
	) => string;
}): Promise<PublishDownloadOutcome> {
	try {
		const res = await fetch(opts.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// The route loads the authorized blueprint and resolves the chosen server.
			body: JSON.stringify({
				appId: opts.appId,
				...(opts.server ? { server: opts.server } : {}),
			}),
			signal: opts.signal,
		});
		if (!opts.isCurrent()) {
			void res.body?.cancel();
			return { ok: false };
		}
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			if (!opts.isCurrent()) return { ok: false };
			const failure = describeApiFailure(
				body,
				`Could not generate ${opts.fileLabel}.`,
			);
			/* With detail lines, the server's headline titles the toast and the
			 * findings fill the body; without them, fall back to a generic title
			 * so the headline isn't repeated as its own body. */
			const toastBody = apiFailureToastBody(failure);
			opts.toast(
				"error",
				failure.details.length > 0 ? failure.message : "Download failed",
				toastBody.message,
				{ lines: toastBody.lines },
			);
			return { ok: false };
		}
		const projectSpaceCompatibility = decodeProjectSpaceCompatibilityReport(
			res.headers.get(PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER),
		);
		// What the file could not carry. Read before the body, discarded
		// silently if it is unreadable: the bytes already arrived and no
		// advisory is worth turning a finished download into a failure.
		const advisories = decodeExportAdvisories(
			res.headers.get(EXPORT_ADVISORY_HEADER),
		);
		const blob = await res.blob();
		if (!opts.isCurrent()) return { ok: false };
		triggerBlobDownload(blob, opts.filename(blob));
		return { ok: true, projectSpaceCompatibility, advisories };
	} catch (error) {
		if (
			opts.signal.aborted ||
			!opts.isCurrent() ||
			(error instanceof DOMException && error.name === "AbortError")
		)
			return { ok: false };
		opts.toast(
			"error",
			"Download failed",
			`Could not generate ${opts.fileLabel}.`,
		);
		return { ok: false };
	}
}

/**
 * Memoized to prevent parent-cascade re-renders from BuilderSubheader.
 * BuilderSubheader re-renders on breadcrumb/navigation changes (correct),
 * but PublishPanel's inputs (the connection context, stable per page load)
 * are unchanged across navigations: the cascade is pure waste (profiler:
 * 16ms wasted).
 */
export const PublishPanel = memo(function PublishPanel() {
	const router = useRouter();
	const docStore = useContext(BlueprintDocContext);
	const session = useBuilderSessionApi();
	const canEdit = useCanEdit();
	const { server, availableDomains } = useCommCareConnection();
	const reconciler = useReconcilerContext();
	const projectToast = useProjectToast();
	const [publishDialogOpen, setPublishDialogOpen] = useState(false);
	const [publishDialogMounted, setPublishDialogMounted] = useState(false);
	/** The project space a pending open request named, held locally so it
	 *  survives past the store request's one-shot clear and is retired on
	 *  close (or on an ordinary manual open, which preseeds nothing). */
	const [requestedDomain, setRequestedDomain] = useState<string | undefined>(
		undefined,
	);
	const publishDialogRequest = usePublishDialogRequest();
	const clearPublishDialogRequest = useClearPublishDialogRequest();
	const [isRefreshingHqConnection, startHqConnectionRefresh] = useTransition();
	const downloadControllersRef = useRef(new Set<AbortController>());
	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				for (const controller of downloadControllersRef.current)
					controller.abort();
				downloadControllersRef.current.clear();
				setPublishDialogOpen(false);
			}),
		[reconciler],
	);
	useEffect(
		() => () => {
			for (const controller of downloadControllersRef.current)
				controller.abort();
			downloadControllersRef.current.clear();
		},
		[],
	);

	const runDownload = useCallback(
		async (
			options: Omit<
				Parameters<typeof downloadArtifact>[0],
				"signal" | "isCurrent" | "toast"
			>,
		): Promise<PublishDownloadOutcome> => {
			const start = session.getState();
			if (start.accessPhase !== "authorized") return { ok: false };
			const epoch = start.scopeEpoch;
			const controller = new AbortController();
			downloadControllersRef.current.add(controller);
			const isCurrent = () => {
				const current = session.getState();
				return (
					!controller.signal.aborted &&
					current.accessPhase === "authorized" &&
					current.scopeEpoch === epoch
				);
			};
			try {
				return await downloadArtifact({
					...options,
					signal: controller.signal,
					isCurrent,
					toast: projectToast,
				});
			} finally {
				downloadControllersRef.current.delete(controller);
			}
		},
		[projectToast, session],
	);

	/**
	 * Snapshot the current persistable doc for the upload dialog. Called
	 * imperatively when the user clicks Upload: no subscription, no
	 * re-renders during form entry.
	 *
	 * PublishPanel is only rendered when a real app is loaded: the Publish
	 * button is hidden until `hasData` on the layout becomes true, and the
	 * dialog is gated behind that button. If this callback somehow runs with an
	 * unmounted doc store, it's a programming error: throw loudly rather
	 * than fabricate an empty doc that would push a zero-module app.
	 */
	const getAppId = useCallback((): string => {
		const s = docStore?.getState();
		if (!s?.appId) {
			throw new Error(
				"PublishPanel.getAppId called before the app was persisted",
			);
		}
		return s.appId;
	}, [docStore]);

	const handleDownloadCcz = useCallback(
		async (
			downloadServer?: CommCareServer,
		): Promise<PublishDownloadOutcome> => {
			const s = docStore?.getState();
			if (!s || s.moduleOrder.length === 0 || !s.appId) return { ok: false };
			// The compile endpoint returns the `.ccz` bytes inline: one request, no
			// separate download round-trip.
			return runDownload({
				appId: s.appId,
				server: downloadServer,
				endpoint: "/api/compile",
				fileLabel: "the .ccz file",
				filename: () => `${s.appName || "app"}.ccz`,
			});
		},
		[docStore, runDownload],
	);

	const handleDownloadJson = useCallback(
		async (
			downloadServer?: CommCareServer,
		): Promise<PublishDownloadOutcome> => {
			const s = docStore?.getState();
			if (!s || s.moduleOrder.length === 0 || !s.appId) return { ok: false };
			return runDownload({
				appId: s.appId,
				server: downloadServer,
				endpoint: "/api/compile/json",
				fileLabel: "the JSON file",
				// Media-aware: a media-free app comes back as a plain `.json`; an app
				// WITH media comes back as a `.zip` bundle. Name the download from the
				// response blob's MIME type.
				filename: (blob) =>
					`${s.appName || "app"}.${blob.type.includes("zip") ? "zip" : "json"}`,
			});
		},
		[docStore, runDownload],
	);

	const loadProjectSpaceCompatibility = useCallback(
		async (
			domain: string | undefined,
			signal: AbortSignal,
		): Promise<PublishProjectSpaceCompatibilityOutcome> => {
			const start = session.getState();
			const appId = docStore?.getState().appId;
			if (start.accessPhase !== "authorized" || !appId) {
				return {
					ok: false,
					message: "Project-space compatibility isn't available right now",
				};
			}
			const scopeEpoch = start.scopeEpoch;
			try {
				const response = await fetch(
					"/api/commcare/project-space-compatibility",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ appId, ...(domain && { domain }) }),
						signal,
					},
				);
				const current = session.getState();
				if (
					signal.aborted ||
					current.accessPhase !== "authorized" ||
					current.scopeEpoch !== scopeEpoch
				) {
					return {
						ok: false,
						message: "The compatibility check was canceled",
					};
				}
				const body = (await response.json().catch(() => null)) as {
					project_space_compatibility?: ProjectSpaceCompatibilityReport;
					error?: string;
				} | null;
				if (!response.ok || !body?.project_space_compatibility) {
					return {
						ok: false,
						message:
							body?.error ??
							"Nova couldn't check whether this project space can run the app. Try again in this window",
					};
				}
				return { ok: true, report: body.project_space_compatibility };
			} catch (error) {
				if (
					signal.aborted ||
					(error instanceof DOMException && error.name === "AbortError")
				) {
					return { ok: false, message: "The compatibility check was canceled" };
				}
				return {
					ok: false,
					message:
						"Nova couldn't check whether this project space can run the app. Try again in this window",
				};
			}
		},
		[docStore, session],
	);

	/* Stable callbacks prevent cascading re-renders through PublishDialog when
	 * PublishPanel re-renders from parent cascade.
	 * Without these, inline arrow functions create new refs on every render,
	 * causing avoidable work throughout the dialog tree. */
	const handleOpenPublish = useCallback(() => {
		const current = session.getState();
		if (current.accessPhase === "authorized") {
			setPublishDialogMounted(true);
			setRequestedDomain(undefined);
			setPublishDialogOpen(true);
		}
	}, [session]);
	const handleClosePublish = useCallback(() => {
		for (const controller of downloadControllersRef.current) controller.abort();
		downloadControllersRef.current.clear();
		setRequestedDomain(undefined);
		setPublishDialogOpen(false);
	}, []);

	/* The Publishing section's "Publish again": a one-shot session-store
	 * request, because the section and this panel live in different render
	 * trees. Consumed here whether or not it can open, so an unauthorized
	 * moment doesn't leave a stale request that fires on the next render. */
	useEffect(() => {
		if (publishDialogRequest === null) return;
		const request = publishDialogRequest;
		clearPublishDialogRequest();
		if (session.getState().accessPhase !== "authorized") return;
		setPublishDialogMounted(true);
		setRequestedDomain(request.domain);
		setPublishDialogOpen(true);
	}, [publishDialogRequest, clearPublishDialogRequest, session]);
	const handleRefreshHqConnection = useCallback(() => {
		startHqConnectionRefresh(() => {
			router.refresh();
		});
	}, [router]);

	/* A plain History-API push rather than `useNavigate`: that hook carries
	 * a `useLocation` subscription, which would re-render this memo-isolated
	 * panel (and the whole dialog tree under it) on every selection change
	 * and doc edit. The base path is read at call time because the new-build
	 * flow rewrites it once the server mints the appId. Preview is exited
	 * first — App setup renders only in edit mode, so landing on its URL
	 * while previewing would show a blank canvas. */
	const handleOpenPublishing = useCallback(() => {
		session.getState().setPreviewing(false);
		const parts = window.location.pathname.split("/").filter(Boolean);
		pushBuilderHistory(
			buildUrl(`/${parts.slice(0, 2).join("/")}`, {
				kind: "app-setup",
				section: "publishing",
			}),
		);
	}, [session]);

	return (
		<>
			<PublishButton
				onClick={handleOpenPublish}
				onPointerEnter={() => void loadPublishDialog()}
				onFocus={() => void loadPublishDialog()}
			/>
			{/* Dialog stays mounted for Base UI exit animations. Stable onClose
			 * prevents re-renders when the dialog is closed (the common case). */}
			{publishDialogMounted ? (
				<PublishDialog
					open={publishDialogOpen}
					onClose={handleClosePublish}
					getAppId={getAppId}
					/* The context already answers a stable empty list when no key is
					 * configured, so this is identity-stable across renders. */
					availableDomains={availableDomains}
					connectionServer={server}
					canUploadToHq={canEdit}
					requestedDomain={requestedDomain}
					onOpenPublishing={handleOpenPublishing}
					isRefreshingHqConnection={isRefreshingHqConnection}
					onRefreshHqConnection={handleRefreshHqConnection}
					onLoadProjectSpaceCompatibility={loadProjectSpaceCompatibility}
					onDownloadJson={handleDownloadJson}
					onDownloadCcz={handleDownloadCcz}
				/>
			) : null}
		</>
	);
});
