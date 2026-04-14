"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import { motion } from "motion/react";
import { useCallback, useState } from "react";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import { Badge } from "@/components/ui/Badge";
import { useBuilderHasData, useBuilderIsReady } from "@/hooks/useBuilder";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOrderedModules } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";
import { useEditMode } from "@/lib/session/hooks";

export function HomeScreen() {
	const appName = useBlueprintDoc((s) => s.appName);
	const formOrder = useBlueprintDoc((s) => s.formOrder);
	const navigate = useNavigate();
	const { updateApp } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const hasData = useBuilderHasData();
	const modules = useOrderedModules();

	const [saved, setSaved] = useState(false);
	const saveAppName = useCallback(
		(name: string) => {
			updateApp({ app_name: name });
		},
		[updateApp],
	);
	const handleSaved = useCallback(() => {
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	}, []);

	if (!hasData) return null;

	const canEdit = mode === "edit" && isReady;

	return (
		<div className="p-6 space-y-4 max-w-3xl mx-auto">
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle
						value={appName}
						onSave={saveAppName}
						onSaved={handleSaved}
					/>
				) : (
					<EditableTitle value={appName} readOnly />
				)}
				<SavedCheck visible={saved} />
			</div>
			<div className="grid gap-3">
				{modules.map((mod, mIdx) => {
					const formCount = formOrder[mod.uuid as Uuid]?.length ?? 0;
					return (
						<motion.button
							key={mod.uuid}
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{
								delay: mIdx * 0.06,
								duration: 0.3,
								ease: [0.16, 1, 0.3, 1],
							}}
							onClick={() => navigate.openModule(mod.uuid)}
							className="w-full flex items-center gap-4 p-4 rounded-xl bg-pv-surface border border-pv-input-border hover:border-pv-input-focus hover:translate-y-[-1px] transition-all duration-200 cursor-pointer text-left group"
						>
							<div className="w-10 h-10 rounded-lg bg-pv-accent/10 flex items-center justify-center shrink-0">
								<Icon
									icon={tablerGridDots}
									width="20"
									height="20"
									className="text-pv-accent"
								/>
							</div>
							<div className="flex-1 min-w-0">
								<div className="font-medium text-nova-text group-hover:text-pv-accent-bright transition-colors">
									{mod.name}
								</div>
								{mod.caseType && (
									<Badge variant="muted" className="mt-1">
										{mod.caseType}
									</Badge>
								)}
							</div>
							<span className="text-xs text-nova-text-muted shrink-0">
								{formCount} form{formCount !== 1 ? "s" : ""}
							</span>
						</motion.button>
					);
				})}
			</div>
		</div>
	);
}
