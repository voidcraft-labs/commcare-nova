"use client";
import { Icon } from "@iconify/react/offline";
import tablerFile from "@iconify-icons/tabler/file";
import tablerFilePencil from "@iconify-icons/tabler/file-pencil";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import {
	useBuilderStore,
	useModule,
	useOrderedForms,
} from "@/hooks/useBuilder";

const formTypeIcons = {
	registration: tablerFilePlus,
	followup: tablerFilePencil,
	survey: tablerFile,
} as const;

interface ModuleDetailProps {
	/** Module index in the blueprint. */
	moduleIndex: number;
}

/**
 * Module editing sub-panel within the DetailPanel.
 * Displays and allows editing of: module name, case type (read-only),
 * case list columns, and a summary of forms in the module.
 */
export function ModuleDetail({ moduleIndex }: ModuleDetailProps) {
	const mod = useModule(moduleIndex);
	const forms = useOrderedForms(moduleIndex);
	const updateModule = useBuilderStore((s) => s.updateModule);

	const saveModule = useCallback(
		(updates: { name?: string }) => {
			updateModule(moduleIndex, updates);
		},
		[updateModule, moduleIndex],
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
								icon={
									formTypeIcons[f.type as keyof typeof formTypeIcons] ??
									tablerFile
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
