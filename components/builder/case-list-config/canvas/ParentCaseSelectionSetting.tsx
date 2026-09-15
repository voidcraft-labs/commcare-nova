"use client";

import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { updateModuleMutation } from "@/lib/doc/addModuleMutation";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useCaseParentModuleOptions } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";

export function ParentCaseSelectionSetting({
	moduleUuid,
}: {
	moduleUuid: Uuid;
}) {
	const id = useId();
	const module = useModule(moduleUuid);
	const options = useCaseParentModuleOptions(moduleUuid);
	const canEdit = useCanEdit();
	const { commitMany } = useBlueprintMutations();
	if (!module || (options.length === 0 && !module.parentCaseModuleUuid))
		return null;
	const value = module.parentCaseModuleUuid ?? "none";
	const label =
		options.find((option) => option.uuid === value)?.name ??
		"No parent selection";
	return (
		<section className="max-w-xl">
			<label
				htmlFor={canEdit ? id : undefined}
				className="text-sm font-medium text-nova-text"
			>
				Choose a parent first
			</label>
			<p className="mt-1 mb-3 text-[13px] leading-relaxed text-nova-text-muted">
				Show records linked to a parent selected in another module. Without this
				step, Results can include records with or without a parent.
			</p>
			{canEdit ? (
				<Select
					value={value}
					onValueChange={(next) => {
						const parent = options.find((option) => option.uuid === next);
						if (next === "none" || parent)
							commitMany([
								updateModuleMutation(moduleUuid, {
									parentCaseModuleUuid: parent?.uuid ?? null,
								}),
							]);
					}}
				>
					<SelectTrigger id={id} className="w-full">
						<SelectValue>{label}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">No parent selection</SelectItem>
						{options.map((option) => (
							<SelectItem key={option.uuid} value={option.uuid}>
								{option.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : (
				<p className="text-sm text-nova-text-secondary">{label}</p>
			)}
		</section>
	);
}
