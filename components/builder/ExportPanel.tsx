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
import { showToast } from "@/lib/services/toastStore";

interface ExportPanelProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** The user's authorized project space domain, or null if not configured. */
	commcareDomain: { name: string; displayName: string } | null;
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
 * Memoized to prevent parent-cascade re-renders from BuilderSubheader.
 * BuilderSubheader re-renders on breadcrumb/navigation changes (correct),
 * but ExportPanel's props (commcareConfigured, commcareDomain) are stable
 * across navigations — the cascade is pure waste (profiler: 16ms wasted).
 */
export const ExportPanel = memo(function ExportPanel({
	commcareConfigured,
	commcareDomain,
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
		try {
			const res = await fetch("/api/compile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ doc: toPersistable(s) }),
			});
			const data = await res.json();
			if (data.downloadUrl) {
				const cczRes = await fetch(data.downloadUrl);
				const blob = await cczRes.blob();
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `${data.appName || "app"}.ccz`;
				a.click();
				URL.revokeObjectURL(url);
			}
		} catch {
			showToast("error", "Export failed", "Could not generate the .ccz file.");
		}
	}, [docStore]);

	const handleExportJson = useCallback(async () => {
		const s = docStore?.getState();
		if (!s || s.moduleOrder.length === 0) return;
		try {
			const res = await fetch("/api/compile/json", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ doc: toPersistable(s) }),
			});
			if (!res.ok) {
				showToast(
					"error",
					"Export failed",
					"Could not generate the JSON file.",
				);
				return;
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${s.appName || "app"}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			showToast("error", "Export failed", "Could not generate the JSON file.");
		}
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
				domain={commcareDomain}
			/>
		</>
	);
});
