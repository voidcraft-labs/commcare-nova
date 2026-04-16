"use client";
import { Icon } from "@iconify/react/offline";
import tablerFile from "@iconify-icons/tabler/file";
import tablerFilePencil from "@iconify-icons/tabler/file-pencil";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import { motion } from "motion/react";
import { useCallback, useState } from "react";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { CASE_LOADING_FORM_TYPES } from "@/lib/schemas/blueprint";
import { useBuilderIsReady, useEditMode } from "@/lib/session/hooks";

const formTypeIcons = {
	registration: tablerFilePlus,
	followup: tablerFilePencil,
	survey: tablerFile,
} as const;

interface ModuleScreenProps {
	/** This screen's identity — which module is being displayed. Passed from
	 *  PreviewShell so the component remains valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "module" }>;
}

export function ModuleScreen({ screen: _screen }: ModuleScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const { updateModule } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();

	/** Module uuid from the URL — used for uuid-first mutations and navigation. */
	const moduleUuid = loc.kind === "module" ? loc.moduleUuid : undefined;

	const mod = useModuleEntity(moduleUuid);
	const forms = useOrderedForms((moduleUuid ?? "") as Uuid);

	const [saved, setSaved] = useState(false);
	const saveModuleName = useCallback(
		(name: string) => {
			if (moduleUuid) updateModule(moduleUuid, { name });
		},
		[updateModule, moduleUuid],
	);
	const handleSaved = useCallback(() => {
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	}, []);

	if (!mod) return null;

	const hasCase = !!mod.caseType;
	const canEdit = mode === "edit" && isReady;

	return (
		<div className="p-6 space-y-4 max-w-3xl mx-auto">
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle
						value={mod.name}
						onSave={saveModuleName}
						onSaved={handleSaved}
					/>
				) : (
					<EditableTitle value={mod.name} readOnly />
				)}
				<SavedCheck visible={saved} />
			</div>

			<div className="space-y-2">
				{forms.map((form, fIdx) => {
					const icon =
						formTypeIcons[form.type as keyof typeof formTypeIcons] ??
						tablerFile;

					const handleClick = () => {
						if (!moduleUuid) return;
						if (CASE_LOADING_FORM_TYPES.has(form.type) && hasCase) {
							/* Case-loading forms show the case list first — selecting a row opens the form */
							navigate.openCaseList(moduleUuid);
						} else {
							navigate.openForm(moduleUuid, form.uuid);
						}
					};

					return (
						<motion.button
							key={form.uuid}
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{
								delay: fIdx * 0.06,
								duration: 0.3,
								ease: [0.16, 1, 0.3, 1],
							}}
							onClick={handleClick}
							className="w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group"
						>
							<Icon
								icon={icon}
								width="18"
								height="18"
								className="text-nova-text-muted group-hover:text-pv-accent transition-colors shrink-0"
							/>
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium text-nova-text">
									{form.name}
								</div>
							</div>
						</motion.button>
					);
				})}
			</div>
		</div>
	);
}
