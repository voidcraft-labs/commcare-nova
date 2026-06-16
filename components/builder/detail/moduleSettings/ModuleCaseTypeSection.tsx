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
import { caseTypeClearPatch, caseTypeSetPatch } from "@/lib/doc/scaffolds";
import type { Uuid } from "@/lib/doc/types";
import type { Module } from "@/lib/domain";

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

	// The set/clear patches (including the born-valid Name-column seed and the
	// config drop on clear) live in `lib/doc/scaffolds` so the rule isn't
	// re-encoded here; this component just supplies what it already has.
	const apply = (patch: Partial<Omit<Module, "uuid">>) => {
		const outcome = inline.updateModule(moduleUuid, patch);
		setError(outcome.ok ? null : outcome.messages.join(" "));
	};

	return (
		<div>
			<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block">
				Case type
			</span>
			<CaseTypePicker
				value={module.caseType}
				onChange={(caseType) =>
					apply(caseTypeSetPatch(module, (formIds?.length ?? 0) > 0, caseType))
				}
				onClear={() => apply(caseTypeClearPatch())}
			/>
			<p className="mt-1.5 text-[11px] text-nova-text-muted">
				The type of case this module manages. Clearing it makes the module a
				survey (forms only, no cases).
			</p>
			{error && <p className="mt-1.5 text-[11px] text-nova-rose/90">{error}</p>}
		</div>
	);
}
