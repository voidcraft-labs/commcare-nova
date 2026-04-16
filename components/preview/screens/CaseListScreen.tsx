"use client";
import { motion } from "motion/react";
import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import { getDummyCases } from "@/lib/preview/engine/dummyData";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useLocation, useNavigate } from "@/lib/routing/hooks";

interface CaseListScreenProps {
	/** This screen's identity — which module the case list belongs to.
	 *  Passed from PreviewShell so the component remains valid while Activity
	 *  hides it. Index-based for downstream consumers that haven't been
	 *  migrated to uuid-first yet. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

export function CaseListScreen({ screen }: CaseListScreenProps) {
	const moduleIndex = screen.moduleIndex;

	const loc = useLocation();
	const navigate = useNavigate();
	const caseTypes = useCaseTypes();

	/** Module and form uuids from the URL — used for uuid-first navigation.
	 *  The case list screen is reached via `?m=<moduleUuid>&view=cases`. The
	 *  form that the user will enter after selecting a case is determined at
	 *  click time by looking up the first case-loading form in the module. */
	const moduleUuid = loc.kind === "cases" ? loc.moduleUuid : undefined;

	/** Read the first form uuid in this module for case-row navigation. The
	 *  case list always opens into the first case-loading form. */
	const firstFormUuid = useBlueprintDoc((s) => {
		if (!moduleUuid) return undefined;
		const formIds = s.formOrder[moduleUuid];
		return formIds?.[0];
	});

	/** Read the first form's name for the header display. */
	const firstFormName = useBlueprintDoc((s) =>
		firstFormUuid ? s.forms[firstFormUuid]?.name : undefined,
	);

	const mod = useModuleEntity(moduleUuid as Uuid);
	const caseType = caseTypes.find((ct) => ct.name === mod?.caseType);
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

	/** Navigate to the form with the selected case. The case list opens
	 *  into the first form in the module (always the case-loading form). */
	const handleRowClick = (_rowIndex: number) => {
		if (!moduleUuid || !firstFormUuid) return;
		navigate.openForm(moduleUuid, firstFormUuid);
	};

	return (
		<div className="p-6 max-w-3xl mx-auto">
			<div className="flex items-center gap-2 mb-1">
				<h2 className="text-lg font-display font-semibold text-nova-text">
					{firstFormName ?? "Cases"}
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
