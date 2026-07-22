/**
 * ExportPanel — self-contained export + upload flow.
 *
 * Owns the export dropdown (JSON, CCZ), the CommCare HQ upload dialog,
 * and the `uploadDialogOpen` state. Colocated so the trigger (dropdown)
 * and the dialog live in the same component — no state coordination
 * through BuilderLayout needed.
 *
 * The client-side surface speaks only the domain shape (`BlueprintDoc`).
 * Any domain → CommCare wire conversion happens server-side at the
 * export / upload routes, which are the only legitimate external
 * emission boundaries.
 */
"use client";
import tablerBrowser from "@iconify-icons/tabler/browser";
import tablerDeviceMobile from "@iconify-icons/tabler/device-mobile";
import {
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { UploadToHqDialog } from "@/components/builder/UploadToHqDialog";
import type { ExportOption } from "@/components/ui/ExportDropdown";
import { ExportDropdown } from "@/components/ui/ExportDropdown";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { apiFailureToastBody, describeApiFailure } from "@/lib/ui/apiFailure";
import type { ToastOptions, ToastSeverity } from "@/lib/ui/toastStore";

interface ExportPanelProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** Every project space the key can upload to (drives the dialog picker). */
	commcareAvailableDomains: { name: string; displayName: string }[];
}

/**
 * Download a Blob under `filename` via a transient object URL. Centralizes the
 * create → click → revoke lifecycle both export handlers share so the revoke is
 * never forgotten — a leaked object URL pins the blob in memory.
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
 * POST a persistable doc to a compile/export endpoint and download the file it
 * returns. The two export buttons differ only in endpoint, the failure-toast
 * noun, and how the filename's extension is derived from the response blob —
 * the request shape, the `res.ok` branch, the blob download, and the
 * network-failure toast are identical, so they live here once. Both endpoints
 * return the artifact bytes on success and JSON on failure, so we branch on
 * `res.ok` and never read the error body as a blob.
 *
 * A rejection reads its `{ error, details }` body and surfaces the actual
 * findings — the boundary gate's per-issue messages name what's wrong and
 * where, so the toast shows those lines rather than a generic "failed".
 */
async function exportDoc(opts: {
	appId: string;
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
}): Promise<void> {
	try {
		const res = await fetch(opts.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// Send only the app id — the route loads the blueprint server-side.
			body: JSON.stringify({ appId: opts.appId }),
			signal: opts.signal,
		});
		if (!opts.isCurrent()) {
			void res.body?.cancel();
			return;
		}
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			if (!opts.isCurrent()) return;
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
				failure.details.length > 0 ? failure.message : "Export failed",
				toastBody.message,
				{ lines: toastBody.lines },
			);
			return;
		}
		const blob = await res.blob();
		if (!opts.isCurrent()) return;
		triggerBlobDownload(blob, opts.filename(blob));
	} catch (error) {
		if (
			opts.signal.aborted ||
			!opts.isCurrent() ||
			(error instanceof DOMException && error.name === "AbortError")
		)
			return;
		opts.toast(
			"error",
			"Export failed",
			`Could not generate ${opts.fileLabel}.`,
		);
	}
}

/**
 * Memoized to prevent parent-cascade re-renders from BuilderSubheader.
 * BuilderSubheader re-renders on breadcrumb/navigation changes (correct),
 * but ExportPanel's props (commcareConfigured, commcareAvailableDomains) are
 * stable across navigations — the cascade is pure waste (profiler: 16ms wasted).
 */
export const ExportPanel = memo(function ExportPanel({
	commcareConfigured,
	commcareAvailableDomains,
}: ExportPanelProps) {
	const docStore = useContext(BlueprintDocContext);
	const session = useBuilderSessionApi();
	const reconciler = useReconcilerContext();
	const projectToast = useProjectToast();
	const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
	const exportControllersRef = useRef(new Set<AbortController>());
	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				for (const controller of exportControllersRef.current)
					controller.abort();
				exportControllersRef.current.clear();
				setUploadDialogOpen(false);
			}),
		[reconciler],
	);
	useEffect(
		() => () => {
			for (const controller of exportControllersRef.current) controller.abort();
			exportControllersRef.current.clear();
		},
		[],
	);

	const runExport = useCallback(
		async (
			options: Omit<
				Parameters<typeof exportDoc>[0],
				"signal" | "isCurrent" | "toast"
			>,
		) => {
			const start = session.getState();
			if (start.accessPhase !== "authorized") return;
			const epoch = start.scopeEpoch;
			const controller = new AbortController();
			exportControllersRef.current.add(controller);
			const isCurrent = () => {
				const current = session.getState();
				return (
					!controller.signal.aborted &&
					current.accessPhase === "authorized" &&
					current.scopeEpoch === epoch
				);
			};
			try {
				await exportDoc({
					...options,
					signal: controller.signal,
					isCurrent,
					toast: projectToast,
				});
			} finally {
				exportControllersRef.current.delete(controller);
			}
		},
		[projectToast, session],
	);

	/**
	 * Snapshot the current persistable doc for the upload dialog. Called
	 * imperatively when the user clicks Upload — no subscription, no
	 * re-renders during form entry.
	 *
	 * ExportPanel is only rendered when a real app is loaded — the export
	 * dropdown is hidden until `hasData` on the layout becomes true, and
	 * the upload dialog is gated behind a button click that requires the
	 * dropdown to be visible. If this callback somehow runs with an
	 * unmounted doc store, it's a programming error: throw loudly rather
	 * than fabricate an empty doc that would push a zero-module app.
	 */
	const getAppId = useCallback((): string => {
		const s = docStore?.getState();
		if (!s?.appId) {
			throw new Error(
				"ExportPanel.getAppId called before the app was persisted",
			);
		}
		return s.appId;
	}, [docStore]);

	const handleExportCcz = useCallback(async () => {
		const s = docStore?.getState();
		if (!s || s.moduleOrder.length === 0 || !s.appId) return;
		// The compile endpoint returns the `.ccz` bytes inline — one request, no
		// separate download round-trip.
		await runExport({
			appId: s.appId,
			endpoint: "/api/compile",
			fileLabel: "the .ccz file",
			filename: () => `${s.appName || "app"}.ccz`,
		});
	}, [docStore, runExport]);

	const handleExportJson = useCallback(async () => {
		const s = docStore?.getState();
		if (!s || s.moduleOrder.length === 0 || !s.appId) return;
		await runExport({
			appId: s.appId,
			endpoint: "/api/compile/json",
			fileLabel: "the JSON file",
			// Media-aware: a media-free app comes back as a plain `.json`; an app
			// WITH media comes back as a `.zip` bundle. Name the download from the
			// response blob's MIME type.
			filename: (blob) =>
				`${s.appName || "app"}.${blob.type.includes("zip") ? "zip" : "json"}`,
		});
	}, [docStore, runExport]);

	const exportOptions: ExportOption[] = useMemo(
		() => [
			{
				label: "Web",
				description: "JSON",
				icon: tablerBrowser,
				onClick: handleExportJson,
			},
			{
				label: "Mobile",
				description: "CCZ",
				icon: tablerDeviceMobile,
				onClick: handleExportCcz,
			},
		],
		[handleExportJson, handleExportCcz],
	);

	/* Stable callbacks — prevent cascading re-renders to ExportDropdown and
	 * UploadToHqDialog when ExportPanel re-renders from parent cascade.
	 * Without these, inline arrow functions create new refs on every render,
	 * causing 3ms+ of wasted re-renders in the dialog tree (profiler shows
	 * UploadToHqDialog re-rendering from props=['onClose'] on every
	 * BuilderSubheader hook change). */
	const handleOpenUpload = useCallback(() => {
		if (session.getState().accessPhase === "authorized") {
			setUploadDialogOpen(true);
		}
	}, [session]);
	const handleCloseUpload = useCallback(() => setUploadDialogOpen(false), []);

	return (
		<>
			<ExportDropdown
				options={exportOptions}
				commcareConfigured={commcareConfigured}
				onCommCareUpload={handleOpenUpload}
			/>
			{/* Dialog stays mounted for Base UI exit animations. Stable onClose
			 * prevents re-renders when the dialog is closed (the common case). */}
			<UploadToHqDialog
				open={uploadDialogOpen}
				onClose={handleCloseUpload}
				getAppId={getAppId}
				availableDomains={commcareAvailableDomains}
			/>
		</>
	);
});
