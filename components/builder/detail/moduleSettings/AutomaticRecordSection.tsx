"use client";
import { useId, useState } from "react";
import { Switch } from "@/components/shadcn/switch";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";

export function AutomaticRecordSection({ moduleUuid }: { moduleUuid: Uuid }) {
	const module = useModule(moduleUuid);
	const { inline } = useBlueprintMutations();
	const canEdit = useCanEdit();
	const id = useId();
	const [refusal, setRefusal] = useState("");
	if (!module?.caseType) return null;
	return (
		<section className="space-y-1">
			<label
				className="flex items-center justify-between gap-2 text-sm text-nova-text"
				htmlFor={id}
			>
				Open a single match automatically
				<Switch
					id={id}
					disabled={!canEdit}
					checked={module.autoSelectSingle === true}
					onCheckedChange={(on) => {
						const result = inline.updateModule(moduleUuid, {
							autoSelectSingle: on ? true : undefined,
						});
						setRefusal(result.ok ? "" : result.messages.join(" "));
					}}
				/>
			</label>
			<p className="text-xs text-nova-text-muted">
				Applies when a form asks the worker to choose a record from this list.
			</p>
			{refusal && (
				<p role="alert" className="text-xs text-nova-rose">
					{refusal}
				</p>
			)}
		</section>
	);
}
