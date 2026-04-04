"use client";
import { useCallback } from "react";
import { Icon } from "@iconify/react/offline";
import ciFileAdd from "@iconify-icons/ci/file-add";
import ciFileEdit from "@iconify-icons/ci/file-edit";
import ciFileBlank from "@iconify-icons/ci/file-blank";
import type { BlueprintModule } from "@/lib/schemas/blueprint";
import type { MutableBlueprint } from "@/lib/services/mutableBlueprint";
import { EditableText } from "@/components/builder/EditableText";

const formTypeIcons = {
	registration: ciFileAdd,
	followup: ciFileEdit,
	survey: ciFileBlank,
} as const;

interface ModuleDetailProps {
	/** The module being edited. */
	mod: BlueprintModule;
	/** Module index in the blueprint. */
	moduleIndex: number;
	/** The MutableBlueprint instance for direct mutation. */
	mb: MutableBlueprint;
	/** Notify the builder that the blueprint has changed. */
	notifyBlueprintChanged: () => void;
}

/**
 * Module editing sub-panel within the DetailPanel.
 * Displays and allows editing of: module name, case type (read-only),
 * case list columns, and a summary of forms in the module.
 */
export function ModuleDetail({
	mod,
	moduleIndex,
	mb,
	notifyBlueprintChanged,
}: ModuleDetailProps) {
	const saveModule = useCallback(
		(updates: { name?: string }) => {
			mb.updateModule(moduleIndex, updates);
			notifyBlueprintChanged();
		},
		[mb, moduleIndex, notifyBlueprintChanged],
	);

	return (
		<>
			<EditableText
				label="Name"
				value={mod.name}
				onSave={(v) => saveModule({ name: v })}
			/>
			{mod.case_type && (
				<div>
					<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
						Case Type
					</span>
					<p className="text-sm font-mono text-nova-cyan-bright">
						{mod.case_type}
					</p>
				</div>
			)}
			{mod.case_list_columns && mod.case_list_columns.length > 0 && (
				<div>
					<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-2 block">
						Case List Columns
					</span>
					<div className="rounded-lg border border-nova-cyan/10 overflow-hidden">
						<div className="grid grid-cols-[1fr_auto] bg-nova-cyan/[0.04]">
							<div className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-nova-cyan-bright uppercase">
								Header
							</div>
							<div className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-nova-text-muted uppercase border-l border-nova-cyan/10">
								Field
							</div>
						</div>
						{mod.case_list_columns.map((col) => (
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
					{mod.forms.map((f, fIdx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: forms have no unique ID field
						<div key={fIdx} className="flex items-center gap-2 text-sm">
							<Icon
								icon={
									formTypeIcons[f.type as keyof typeof formTypeIcons] ??
									ciFileBlank
								}
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
