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
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { UploadToHqDialog } from "@/components/builder/UploadToHqDialog";
import type { ExportOption } from "@/components/ui/ExportDropdown";
import { ExportDropdown } from "@/components/ui/ExportDropdown";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { showToast } from "@/lib/ui/toastStore";

interface ExportPanelProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** Every project space the key can upload to (drives the dialog picker). */
	commcareAvailableDomains: { name: string; displayName: string }[];
}

/**
 * Strip the transient `fieldParent` reverse-index before serializing the
 * doc over the network. `fieldParent` is derived on load (not persisted),
 * and shipping it redundantly would waste bandwidth and muddle the wire
 * contract — the server's `blueprintDocSchema` parse rejects unknown
 * keys on the persistable shape.
 */
function toPersistable(doc: BlueprintDoc): PersistableDoc {
	const { fieldParent: _fp, ...persistable } = doc;
	return persistable;
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
 */
async function exportDoc(opts: {
	doc: PersistableDoc;
	endpoint: string;
	/** Noun for the failure toast, e.g. `"the .ccz file"` / `"the JSON file"`. */
	fileLabel: string;
	/** Derive the download filename from the response blob (its MIME type may pick the extension). */
	filename: (blob: Blob) => string;
}): Promise<void> {
	try {
		const res = await fetch(opts.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ doc: opts.doc }),
		});
		if (!res.ok) {
			showToast(
				"error",
				"Export failed",
				`Could not generate ${opts.fileLabel}.`,
			);
			return;
		}
		const blob = await res.blob();
		triggerBlobDownload(blob, opts.filename(blob));
	} catch {
		showToast(
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
	const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

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
	const getDoc = useCallback((): PersistableDoc => {
		const s = docStore?.getState();
		if (!s) {
			throw new Error(
				"ExportPanel.getDoc called before BlueprintDocProvider mounted",
			);
		}
		return toPersistable(s);
	}, [docStore]);

	const handleExportCcz = useCallback(async () => {
		const s = docStore?.getState();
		if (!s || s.moduleOrder.length === 0) return;
		// The compile endpoint returns the `.ccz` bytes inline — one request, no
		// separate download round-trip.
		await exportDoc({
			doc: toPersistable(s),
			endpoint: "/api/compile",
			fileLabel: "the .ccz file",
			filename: () => `${s.appName || "app"}.ccz`,
		});
	}, [docStore]);

	const handleExportJson = useCallback(async () => {
		const s = docStore?.getState();
		if (!s || s.moduleOrder.length === 0) return;
		await exportDoc({
			doc: toPersistable(s),
			endpoint: "/api/compile/json",
			fileLabel: "the JSON file",
			// Media-aware: a media-free app comes back as a plain `.json`; an app
			// WITH media comes back as a `.zip` bundle. Name the download from the
			// response blob's MIME type.
			filename: (blob) =>
				`${s.appName || "app"}.${blob.type.includes("zip") ? "zip" : "json"}`,
		});
	}, [docStore]);

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
	const handleOpenUpload = useCallback(() => setUploadDialogOpen(true), []);
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
				getDoc={getDoc}
				availableDomains={commcareAvailableDomains}
			/>
		</>
	);
});
