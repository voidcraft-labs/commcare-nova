"use client";
import { Icon } from "@iconify/react/offline";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";

interface ModuleDetailProps {
	/** Module uuid in the blueprint. */
	moduleUuid: Uuid;
}

/**
 * Module editing sub-panel within the DetailPanel.
 * Displays and allows editing of: module name, case type (read-only),
 * case list columns, and a summary of forms in the module.
 */
export function ModuleDetail({ moduleUuid }: ModuleDetailProps) {
	const mod = useModule(moduleUuid);
	const forms = useOrderedForms(moduleUuid);
	const { updateModule } = useBlueprintMutations();

	const saveModule = useCallback(
		(updates: { name?: string }) => {
			updateModule(asUuid(moduleUuid), updates);
		},
		[updateModule, moduleUuid],
	);

	if (!mod) return null;

	return (
		<>
			<EditableText
				label="Name"
				value={mod.name}
				onSave={(v) => saveModule({ name: v })}
			/>
			{mod.caseType && (
				<div>
					<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
						Case Type
					</span>
					<p className="text-sm font-mono text-nova-violet-bright">
						{mod.caseType}
					</p>
				</div>
			)}
			{mod.caseListColumns && mod.caseListColumns.length > 0 && (
				<div>
					<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-2 block">
						Case List Columns
					</span>
					<div className="rounded-lg border border-white/[0.06] overflow-hidden">
						<div className="grid grid-cols-[1fr_auto] bg-white/[0.02]">
							<div className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-nova-text-secondary uppercase">
								Header
							</div>
							<div className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-nova-text-muted uppercase border-l border-white/[0.06]">
								Field
							</div>
						</div>
						{mod.caseListColumns.map((col) => (
							<div
								key={`${col.header}-${col.field}`}
								className="grid grid-cols-[1fr_auto] border-t border-nova-border/40"
							>
								<div className="px-3 py-1.5 text-sm text-nova-text-secondary">
									{col.header}
								</div>
								<div className="px-3 py-1.5 text-xs font-mono text-nova-text-muted border-l border-nova-border/30">
									{col.field}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
			<div>
				<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
					Forms
				</span>
				<div className="space-y-1">
					{forms.map((f) => (
						<div key={f.uuid} className="flex items-center gap-2 text-sm">
							<Icon
								icon={formTypeIcons[f.type]}
								width="14"
								height="14"
								className="text-nova-text-muted shrink-0"
							/>
							<span>{f.name}</span>
						</div>
					))}
				</div>
			</div>
		</>
	);
}
