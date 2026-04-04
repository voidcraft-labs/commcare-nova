"use client";
import { useState, useCallback } from "react";
import { motion } from "motion/react";
import { Icon } from "@iconify/react/offline";
import ciMoreGridBig from "@iconify-icons/ci/more-grid-big";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import type { Builder } from "@/lib/services/builder";
import type { EditMode } from "@/hooks/useEditContext";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { Badge } from "@/components/ui/Badge";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";

interface HomeScreenProps {
	blueprint: AppBlueprint;
	onNavigate: (screen: PreviewScreen) => void;
	builder?: Builder;
	mode?: EditMode;
}

export function HomeScreen({
	blueprint,
	onNavigate,
	builder,
	mode = "edit",
}: HomeScreenProps) {
	const [saved, setSaved] = useState(false);
	const saveAppName = useCallback(
		(name: string) => {
			if (!builder?.mb) return;
			builder.mb.updateApp({ app_name: name });
			builder.notifyBlueprintChanged();
		},
		[builder],
	);
	const handleSaved = useCallback(() => {
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	}, []);

	return (
		<div className="p-6 space-y-4 max-w-3xl mx-auto">
			<div className="flex items-center gap-2">
				{mode === "edit" && builder?.mb ? (
					<EditableTitle
						value={blueprint.app_name}
						onSave={saveAppName}
						onSaved={handleSaved}
					/>
				) : (
					<EditableTitle value={blueprint.app_name} readOnly />
				)}
				<SavedCheck visible={saved} />
			</div>
			<div className="grid gap-3">
				{blueprint.modules.map((mod, mIdx) => (
					<motion.button
						// biome-ignore lint/suspicious/noArrayIndexKey: modules have no unique ID — name is user-editable and not unique
						key={mIdx}
						initial={{ opacity: 0, y: 12 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{
							delay: mIdx * 0.06,
							duration: 0.3,
							ease: [0.16, 1, 0.3, 1],
						}}
						onClick={() => onNavigate({ type: "module", moduleIndex: mIdx })}
						className="w-full flex items-center gap-4 p-4 rounded-xl bg-pv-surface border border-pv-input-border hover:border-pv-input-focus hover:translate-y-[-1px] transition-all duration-200 cursor-pointer text-left group"
					>
						<div className="w-10 h-10 rounded-lg bg-pv-accent/10 flex items-center justify-center shrink-0">
							<Icon
								icon={ciMoreGridBig}
								width="20"
								height="20"
								className="text-pv-accent"
							/>
						</div>
						<div className="flex-1 min-w-0">
							<div className="font-medium text-nova-text group-hover:text-pv-accent-bright transition-colors">
								{mod.name}
							</div>
							{mod.case_type && (
								<Badge variant="muted" className="mt-1">
									{mod.case_type}
								</Badge>
							)}
						</div>
						<span className="text-xs text-nova-text-muted shrink-0">
							{mod.forms.length} form{mod.forms.length !== 1 ? "s" : ""}
						</span>
					</motion.button>
				))}
			</div>
		</div>
	);
}
