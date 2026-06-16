// components/builder/detail/moduleSettings/ModuleCaseTypeSection.tsx
//
// Module-settings section for viewing and changing a module's case type. Picks
// an existing type, creates a new one, or clears it — all through the gated
// `updateModule` (the inline flavor, so a rejection renders beside the control
// instead of only as a toast). The hook already runs the case-type retirement
// cascade; this section adds one thing the SA's `updateModule` tool also does:
// when a type is set on a module that has forms but no case-list columns, it
// seeds a "Name" column in the same batch so the change stays valid
// (`MISSING_CASE_LIST_COLUMNS`). A change the gate refuses (e.g. clearing the
// type while case forms still need it) surfaces the validator's message inline.

"use client";
import { useState } from "react";
import { CaseTypePicker } from "@/components/builder/shared/CaseTypePicker";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useFormIds } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { asUuid, type Module, plainColumn } from "@/lib/domain";

interface ModuleCaseTypeSectionProps {
	moduleUuid: Uuid;
}

export function ModuleCaseTypeSection({
	moduleUuid,
}: ModuleCaseTypeSectionProps) {
	const module = useModule(moduleUuid);
	const formIds = useFormIds(moduleUuid);
	const { inline } = useBlueprintMutations();
	const [error, setError] = useState<string | null>(null);

	if (!module) return null;
	const uuid = asUuid(moduleUuid);

	const hasForms = (formIds?.length ?? 0) > 0;
	const hasColumns = (module.caseListConfig?.columns.length ?? 0) > 0;

	const apply = (patch: Partial<Omit<Module, "uuid">>) => {
		const outcome = inline.updateModule(uuid, patch);
		setError(outcome.ok ? null : outcome.messages.join(" "));
	};

	const handleChange = (caseType: string) => {
		const patch: Partial<Omit<Module, "uuid">> = { caseType };
		// A case-managing module with forms must carry at least one case-list
		// column; seed a "Name" one when the module has none so setting a type
		// on a form-bearing module doesn't introduce MISSING_CASE_LIST_COLUMNS.
		if (hasForms && !hasColumns) {
			patch.caseListConfig = {
				columns: [
					plainColumn(asUuid(crypto.randomUUID()), "case_name", "Name"),
				],
				searchInputs: module.caseListConfig?.searchInputs ?? [],
				...(module.caseListConfig?.filter && {
					filter: module.caseListConfig.filter,
				}),
			};
		}
		apply(patch);
	};

	return (
		<div>
			<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block">
				Case type
			</span>
			<CaseTypePicker
				value={module.caseType}
				onChange={handleChange}
				onClear={() => apply({ caseType: undefined })}
			/>
			<p className="mt-1.5 text-[11px] text-nova-text-muted">
				The type of case this module manages. Clearing it makes the module a
				survey (forms only, no cases).
			</p>
			{error && <p className="mt-1.5 text-[11px] text-nova-rose/90">{error}</p>}
		</div>
	);
}
