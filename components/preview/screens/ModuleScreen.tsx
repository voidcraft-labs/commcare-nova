"use client";
import { useState, useCallback } from "react";
import { motion } from "motion/react";
import { Icon } from "@iconify/react/offline";
import ciFileAdd from "@iconify-icons/ci/file-add";
import ciFileEdit from "@iconify-icons/ci/file-edit";
import ciFileBlank from "@iconify-icons/ci/file-blank";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import type { Builder } from "@/lib/services/builder";
import type { EditMode } from "@/hooks/useEditContext";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";

interface ModuleScreenProps {
	blueprint: AppBlueprint;
	moduleIndex: number;
	onNavigate: (screen: PreviewScreen) => void;
	builder?: Builder;
	mode?: EditMode;
}

const formTypeIcons = {
	registration: ciFileAdd,
	followup: ciFileEdit,
	survey: ciFileBlank,
} as const;

export function ModuleScreen({
	blueprint,
	moduleIndex,
	onNavigate,
	builder,
	mode = "edit",
}: ModuleScreenProps) {
	const mod = blueprint.modules[moduleIndex];

	const [saved, setSaved] = useState(false);
	const saveModuleName = useCallback(
		(name: string) => {
			if (!builder?.mb) return;
			builder.mb.updateModule(moduleIndex, { name });
			builder.notifyBlueprintChanged();
		},
		[builder, moduleIndex],
	);
	const handleSaved = useCallback(() => {
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	}, []);

	if (!mod) return null;

	const hasCase = !!mod.case_type;

	return (
		<div className="p-6 space-y-4 max-w-3xl mx-auto">
			<div className="flex items-center gap-2">
				{mode === "edit" && builder?.mb ? (
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
				{mod.forms.map((form, fIdx) => {
					const icon =
						formTypeIcons[form.type as keyof typeof formTypeIcons] ??
						ciFileBlank;

					const handleClick = () => {
						if (form.type === "followup" && hasCase) {
							// Followup forms show the case list first — selecting a row opens the form
							onNavigate({ type: "caseList", moduleIndex, formIndex: fIdx });
						} else {
							onNavigate({ type: "form", moduleIndex, formIndex: fIdx });
						}
					};

					return (
						<motion.button
							// biome-ignore lint/suspicious/noArrayIndexKey: forms have no unique ID field
							key={fIdx}
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
