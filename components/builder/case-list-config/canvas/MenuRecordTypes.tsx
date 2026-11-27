"use client";

import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedModules } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";

export function MenuRecordTypes({ moduleUuid }: { moduleUuid: Uuid }) {
	const module = useModule(moduleUuid);
	const modules = useOrderedModules();
	const canEdit = useCanEdit();
	const { commitMany } = useBlueprintMutations();
	if (!module?.caseType) return null;
	const selected = module.caseListConfig?.additionalCaseTypes ?? [];
	const candidates = [
		...new Set([
			...modules.flatMap((menu) => (menu.caseType ? [menu.caseType] : [])),
			...selected,
		]),
	]
		.filter((type) => type !== module.caseType)
		.sort();
	if (!candidates.length) return null;
	return (
		<section aria-label="Other record types" className="max-w-xl space-y-2">
			<h3 className="text-sm font-medium">Other record types</h3>
			<p className="text-xs text-nova-text-secondary">
				Workers can choose a {module.caseType} record here. Which other records
				can they open?
			</p>
			{candidates.map((type) => (
				<ToggleRow
					key={type}
					label={type}
					checked={selected.includes(type)}
					disabledReason={
						canEdit
							? undefined
							: "An editor can change which records this menu offers."
					}
					onChange={(on) => {
						const next = on
							? [...selected, type].sort()
							: selected.filter((value) => value !== type);
						commitMany([
							...(module.caseListConfig
								? []
								: [
										{
											kind: "updateModule" as const,
											uuid: moduleUuid,
											patch: {},
											ensureCaseListConfig: true as const,
										},
									]),
							{
								kind: "setCaseListMeta",
								uuid: moduleUuid,
								patch: { additionalCaseTypes: next.length ? next : null },
							},
						]);
					}}
				/>
			))}
		</section>
	);
}
