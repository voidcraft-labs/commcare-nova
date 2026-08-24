"use client";

import { useId, useState } from "react";
import { placementAtEnd } from "@/components/builder/appTree/modulePlacement";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useModuleMenuHierarchy } from "@/lib/doc/hooks/useModuleIds";
import { type Uuid, uuidSchema } from "@/lib/domain";

const TOP_LEVEL = "__top_level__";

export function MenuPlacementSection({
	moduleUuid,
}: {
	readonly moduleUuid: Uuid;
}) {
	const id = useId();
	const module = useModule(moduleUuid);
	const parentModule = useModule(module?.parentModuleUuid);
	const { rootModuleUuids, childModuleUuidsByRoot } = useModuleMenuHierarchy();
	const { inline } = useBlueprintMutations();
	const [error, setError] = useState<string | null>(null);
	if (module === undefined) return null;

	const parentModuleUuid = module.parentModuleUuid ?? null;
	const ownsChildren = (childModuleUuidsByRoot[moduleUuid]?.length ?? 0) > 0;
	const value = parentModuleUuid ?? TOP_LEVEL;
	const valueLabel =
		parentModuleUuid === null ? "Top level" : (parentModule?.name ?? "Menu");
	const choices = rootModuleUuids.filter((rootUuid) => rootUuid !== moduleUuid);

	const moveTo = (nextValue: string | null) => {
		if (nextValue === null || nextValue === value) return;
		let nextParent: Uuid | null;
		if (nextValue === TOP_LEVEL) {
			nextParent = null;
		} else {
			const parsedParent = uuidSchema.safeParse(nextValue);
			if (!parsedParent.success) {
				setError("That menu is no longer available. Choose another one.");
				return;
			}
			nextParent = parsedParent.data;
		}
		const outcome = inline.moveModule(
			moduleUuid,
			placementAtEnd(
				moduleUuid,
				nextParent,
				rootModuleUuids,
				childModuleUuidsByRoot,
			),
		);
		setError(outcome.ok ? null : outcome.messages.join(" "));
	};

	return (
		<Field data-invalid={error !== null}>
			<FieldLabel htmlFor={id}>Menu placement</FieldLabel>
			<Select value={value} disabled={ownsChildren} onValueChange={moveTo}>
				<SelectTrigger
					id={id}
					wrapValue
					className="w-full"
					aria-invalid={error !== null}
				>
					<SelectValue>{valueLabel}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={TOP_LEVEL}>Top level</SelectItem>
					{choices.map((rootUuid) => (
						<MenuPlacementChoice key={rootUuid} moduleUuid={rootUuid} />
					))}
				</SelectContent>
			</Select>
			<FieldDescription>
				{ownsChildren
					? "Move its submenus first, then choose another menu."
					: "Top-level modules appear on Home. A submenu appears inside its parent menu."}
			</FieldDescription>
			{error !== null && <FieldError>{error}</FieldError>}
		</Field>
	);
}

function MenuPlacementChoice({ moduleUuid }: { readonly moduleUuid: Uuid }) {
	const module = useModule(moduleUuid);
	if (module === undefined) return null;
	return (
		<SelectItem value={moduleUuid} wrap>
			{module.name}
		</SelectItem>
	);
}
