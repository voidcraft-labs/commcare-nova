"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import tablerHierarchy from "@iconify-icons/tabler/hierarchy";
import tablerLayoutGrid from "@iconify-icons/tabler/layout-grid";
import {
	placementAtEnd,
	siblingMovePlacement,
} from "@/components/builder/appTree/modulePlacement";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";

export interface ModuleActionsProps {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly parentModuleUuid: Uuid | null;
	readonly siblingModuleUuids: readonly Uuid[];
	readonly rootModuleUuids: readonly Uuid[];
	readonly childModuleUuidsByRoot: Readonly<Record<Uuid, readonly Uuid[]>>;
	readonly hasChildren: boolean;
	readonly searchActive: boolean;
	readonly locked?: boolean;
	readonly onPlacementCommitted: (
		moduleUuid: Uuid,
		destinationParentModuleUuid?: Uuid | null,
	) => void;
}

/** Complete keyboard/touch placement surface. Drag-and-drop is deliberately
 * unnecessary: every valid destination and sibling move is available here. */
export function ModuleActions({
	moduleUuid,
	moduleName,
	parentModuleUuid,
	siblingModuleUuids,
	rootModuleUuids,
	childModuleUuidsByRoot,
	hasChildren,
	searchActive,
	locked,
	onPlacementCommitted,
}: ModuleActionsProps) {
	const canEdit = useCanEdit();
	const { moveModule } = useBlueprintMutations();
	if (!canEdit || locked) return null;

	const index = siblingModuleUuids.indexOf(moduleUuid);
	const canMoveUp = !searchActive && index > 0;
	const canMoveDown =
		!searchActive && index >= 0 && index < siblingModuleUuids.length - 1;
	const eligibleParents = hasChildren
		? []
		: rootModuleUuids.filter(
				(rootUuid) => rootUuid !== moduleUuid && rootUuid !== parentModuleUuid,
			);

	const commit = (placement: {
		readonly after: Uuid | null;
		readonly parentModuleUuid?: Uuid | null;
	}) => {
		const outcome = moveModule(moduleUuid, placement);
		if (outcome.ok)
			onPlacementCommitted(moduleUuid, placement.parentModuleUuid);
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button type="button" variant="ghost" size="icon" />}
				aria-label={`Module actions for ${moduleName}`}
				data-module-actions={moduleUuid}
				className="text-nova-text-muted not-disabled:hover:text-nova-text"
			>
				<Icon icon={tablerDotsVertical} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" preferredMinWidth="13rem">
				<DropdownMenuItem
					disabled={!canMoveUp}
					onClick={() => {
						const placement = siblingMovePlacement(
							moduleUuid,
							siblingModuleUuids,
							"up",
						);
						if (placement) commit(placement);
					}}
				>
					<Icon icon={tablerArrowUp} />
					<span className="flex min-w-0 flex-col">
						<span>Move up</span>
						{searchActive && (
							<span className="text-xs text-nova-text-muted">
								Clear search to reorder
							</span>
						)}
					</span>
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={!canMoveDown}
					onClick={() => {
						const placement = siblingMovePlacement(
							moduleUuid,
							siblingModuleUuids,
							"down",
						);
						if (placement) commit(placement);
					}}
				>
					<Icon icon={tablerArrowDown} />
					<span>Move down</span>
				</DropdownMenuItem>

				{parentModuleUuid !== null && (
					<DropdownMenuItem
						onClick={() =>
							commit(
								placementAtEnd(
									moduleUuid,
									null,
									rootModuleUuids,
									childModuleUuidsByRoot,
								),
							)
						}
					>
						<Icon icon={tablerLayoutGrid} />
						<span>Make top-level</span>
					</DropdownMenuItem>
				)}

				{!hasChildren && (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger disabled={eligibleParents.length === 0}>
							<Icon icon={tablerHierarchy} />
							Move to menu
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent preferredMinWidth="12rem">
							{eligibleParents.map((rootUuid) => (
								<MoveToMenuItem
									key={rootUuid}
									moduleUuid={rootUuid}
									onSelect={() =>
										commit(
											placementAtEnd(
												moduleUuid,
												rootUuid,
												rootModuleUuids,
												childModuleUuidsByRoot,
											),
										)
									}
								/>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function MoveToMenuItem({
	moduleUuid,
	onSelect,
}: {
	readonly moduleUuid: Uuid;
	readonly onSelect: () => void;
}) {
	const module = useModule(moduleUuid);
	if (module === undefined) return null;
	return (
		<DropdownMenuItem onClick={onSelect}>
			<span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
				{module.name}
			</span>
		</DropdownMenuItem>
	);
}
