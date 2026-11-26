"use client";

import { useId } from "react";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOwnerPlatformFeatures } from "@/lib/doc/hooks/usePlatformNotes";
import { PlatformNoteRow } from "../../shared/PlatformNoteRow";
import { SelectMenu } from "../formSettings/SelectMenu";

const LAYOUTS = [
	{ value: "list", label: "List" },
	{ value: "grid", label: "Grid" },
] as const;
const FORM_LAYOUTS = [
	...LAYOUTS,
	{ value: "individual", label: "Choose per menu" },
] as const;

export function AppMenuLayoutSection() {
	const features = useOwnerPlatformFeatures({ kind: "app" }, ["menu-layout"]);
	const settings = useAppSettings();
	const { setAppSettings } = useBlueprintMutations();
	const firstId = useId();
	const formsId = useId();
	return (
		<section className="space-y-2 border-t border-nova-border pt-3">
			<h3 className="text-xs font-medium text-nova-text-secondary">
				Menu layout
			</h3>
			<label htmlFor={firstId} className="block text-xs text-nova-text">
				First menu
			</label>
			<SelectMenu
				triggerId={firstId}
				options={LAYOUTS}
				value={settings.firstMenuLayout ?? "list"}
				onChange={(layout) =>
					setAppSettings({ firstMenuLayout: layout === "grid" ? layout : null })
				}
			/>
			<label htmlFor={formsId} className="block text-xs text-nova-text">
				Other menus
			</label>
			<SelectMenu
				triggerId={formsId}
				options={FORM_LAYOUTS}
				value={settings.formMenuLayout ?? "list"}
				onChange={(layout) =>
					setAppSettings({ formMenuLayout: layout === "list" ? null : layout })
				}
			/>
			{settings.formMenuLayout === "individual" && (
				<p className="text-xs text-nova-text-muted">
					Each menu’s settings let you choose its layout.
				</p>
			)}
			<PlatformNoteRow features={features} />
		</section>
	);
}
