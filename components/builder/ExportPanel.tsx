/**
 * ExportPanel — self-contained export + upload flow.
 *
 * Owns the export dropdown (JSON, CCZ), the CommCare HQ upload dialog,
 * and the `uploadDialogOpen` state. Colocated so the trigger (dropdown)
 * and the dialog live in the same component — no state coordination
 * through BuilderLayout needed.
 *
 * Reads `commcareSettings` from props (server-resolved by the RSC page)
 * and the blueprint from the store imperatively (not a subscription).
 */
"use client";
import tablerBrowser from "@iconify-icons/tabler/browser";
import tablerDeviceMobile from "@iconify-icons/tabler/device-mobile";
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { UploadToHqDialog } from "@/components/builder/UploadToHqDialog";
import type { ExportOption } from "@/components/ui/ExportDropdown";
import { ExportDropdown } from "@/components/ui/ExportDropdown";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	assembleBlueprint,
	type NormalizedData,
} from "@/lib/services/normalizedState";
import { showToast } from "@/lib/services/toastStore";

interface ExportPanelProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** The user's authorized project space domain, or null if not configured. */
	commcareDomain: { name: string; displayName: string } | null;
}

/** Adapt a BlueprintDoc snapshot to the legacy `NormalizedData` shape that
 *  `assembleBlueprint` expects. The underlying entity shapes are identical;
 *  the cast crosses only the branded-`Uuid` vs plain-`string` key boundary. */
function docToNormalized(s: BlueprintDoc): NormalizedData {
	return {
		appName: s.appName,
		connectType: s.connectType ?? undefined,
		caseTypes: s.caseTypes ?? [],
		modules: s.modules as unknown as NormalizedData["modules"],
		forms: s.forms as unknown as NormalizedData["forms"],
		questions: s.questions as unknown as NormalizedData["questions"],
		moduleOrder: s.moduleOrder as unknown as string[],
		formOrder: s.formOrder as unknown as Record<string, string[]>,
		questionOrder: s.questionOrder as unknown as Record<string, string[]>,
	};
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

	/** Assemble the current blueprint for the upload dialog. */
	const getBlueprint = useCallback(() => {
		const s = docStore?.getState();
		return s
			? assembleBlueprint(docToNormalized(s))
			: assembleBlueprint({
					appName: "",
					connectType: undefined,
					caseTypes: [],
					modules: {},
					forms: {},
					questions: {},
					moduleOrder: [],
					formOrder: {},
					questionOrder: {},
				});
	}, [docStore]);

	const handleExportCcz = useCallback(async () => {
		const s = docStore?.getState();
		if (!s || s.moduleOrder.length === 0) return;
		const bp = assembleBlueprint(docToNormalized(s));
		try {
			const res = await fetch("/api/compile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blueprint: bp }),
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
		const bp = assembleBlueprint(docToNormalized(s));
		try {
			const res = await fetch("/api/compile/json", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blueprint: bp }),
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
				getBlueprint={getBlueprint}
				domain={commcareDomain}
			/>
		</>
	);
});
