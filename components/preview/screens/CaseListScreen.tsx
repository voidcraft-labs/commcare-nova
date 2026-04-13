"use client";
import { motion } from "motion/react";
import { useMemo } from "react";
import { useBuilderStore, useForm, useModule } from "@/hooks/useBuilder";
import { getDummyCases } from "@/lib/preview/engine/dummyData";
import type { PreviewScreen } from "@/lib/preview/engine/types";

interface CaseListScreenProps {
	/** This screen's identity — which module/form the case list belongs to.
	 *  Passed from PreviewShell so the component remains valid while Activity
	 *  hides it. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

export function CaseListScreen({ screen }: CaseListScreenProps) {
	const moduleIndex = screen.moduleIndex;
	const formIndex = screen.formIndex;

	const caseTypes = useBuilderStore((s) => s.caseTypes);
	const navPush = useBuilderStore((s) => s.navPush);

	const mod = useModule(moduleIndex);
	const form = useForm(moduleIndex, formIndex);
	const caseType = caseTypes?.find((ct) => ct.name === mod?.caseType);
	const columns = mod?.caseListColumns ?? [];

	const rows = useMemo(() => {
		if (!caseType) return [];
		return getDummyCases(caseType);
	}, [caseType]);

	if (!mod || !caseType || columns.length === 0) {
		return (
			<div className="p-6 text-center text-nova-text-muted">
				No case list configured for this module.
			</div>
		);
	}

	const handleRowClick = (rowIndex: number) => {
		const row = rows[rowIndex];
		navPush({
			type: "form",
			moduleIndex,
			formIndex,
			caseId: row.case_id,
		});
	};

	return (
		<div className="p-6 max-w-3xl mx-auto">
			<div className="flex items-center gap-2 mb-1">
				<h2 className="text-lg font-display font-semibold text-nova-text">
					{form?.name}
				</h2>
			</div>
			<p className="text-sm text-nova-text-muted mb-4">
				Select a case to continue
			</p>

			<div className="rounded-lg border border-pv-input-border overflow-hidden">
				<table className="w-full text-sm">
					<thead>
						<tr className="bg-pv-surface">
							{columns.map((col) => (
								<th
									key={`${col.header}-${col.field}`}
									className="text-left px-4 py-2.5 font-medium text-pv-accent-bright border-b border-pv-input-border"
								>
									{col.header}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rIdx) => (
							<motion.tr
								key={row.case_id}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{ delay: rIdx * 0.04, duration: 0.2 }}
								onClick={() => handleRowClick(rIdx)}
								className={`cursor-pointer hover:bg-pv-elevated ${
									rIdx % 2 === 0 ? "bg-pv-bg" : "bg-pv-surface/50"
								} transition-colors`}
							>
								{columns.map((col) => (
									<td
										key={`${col.header}-${col.field}`}
										className="px-4 py-2 text-nova-text-secondary border-b border-pv-input-border/50"
									>
										{row.properties.get(col.field) ?? ""}
									</td>
								))}
							</motion.tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
