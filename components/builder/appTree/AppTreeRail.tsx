/**
 * AppTreeRail — the structure sidebar's collapsed state: a slim icon
 * rail instead of nothing. Every top-level destination stays one
 * click away — module screens, each case-typed module's Case List &
 * Search workspace, and every form — so collapsing the tree trades
 * width for labels, never for reach.
 *
 * Rows mirror the expanded tree's order: module tile, then its
 * case-list node, then its forms, separated per module. Active
 * destination carries the violet treatment; hover reveals the name
 * via tooltip.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerLayoutSidebarLeftExpand from "@iconify-icons/tabler/layout-sidebar-left-expand";
import tablerTable from "@iconify-icons/tabler/table";
import { memo } from "react";
import { useAppTreeSelection } from "@/components/builder/appTree/useAppTreeSelection";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useFormIds, useModuleIds } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import {
	useIsCaseListSelected,
	useIsFormSelected,
	useLocation,
} from "@/lib/routing/hooks";

export function AppTreeRail({ onExpand }: { onExpand: () => void }) {
	const moduleIds = useModuleIds();
	return (
		<aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-nova-border-bright bg-nova-deep">
			<div
				className="grid h-16 w-full shrink-0 place-items-center border-b border-nova-border"
				data-builder-secondary-header="structure-rail"
			>
				<SimpleTooltip content="Expand structure" side="right">
					<button
						type="button"
						onClick={onExpand}
						aria-label="Expand structure sidebar"
						className="grid size-11 cursor-pointer place-items-center rounded-lg text-nova-text-muted transition-colors hover:bg-white/[0.05] hover:text-nova-text"
					>
						<Icon icon={tablerLayoutSidebarLeftExpand} width="18" height="18" />
					</button>
				</SimpleTooltip>
			</div>
			<div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
				{moduleIds.map((moduleUuid) => (
					<RailModuleGroup key={moduleUuid} moduleUuid={moduleUuid} />
				))}
			</div>
		</aside>
	);
}

const RailModuleGroup = memo(function RailModuleGroup({
	moduleUuid,
}: {
	moduleUuid: Uuid;
}) {
	const mod = useModule(moduleUuid);
	const formIds = useFormIds(moduleUuid);
	const onSelect = useAppTreeSelection();
	const loc = useLocation();
	const isCaseListSelected = useIsCaseListSelected(moduleUuid);
	/* Exact-module selection (not the descendant-inclusive predicate) —
	 * the rail highlights the precise destination, so a form screen
	 * lights its form icon, not the parent module's. */
	const isModuleScreen = loc.kind === "module" && loc.moduleUuid === moduleUuid;

	if (!mod) return null;

	return (
		<>
			<div className="w-7 h-px bg-nova-border my-1" aria-hidden="true" />
			<RailButton
				label={mod.name}
				active={isModuleScreen}
				onClick={() => onSelect({ kind: "module", moduleUuid })}
			>
				{mod.icon ? (
					// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
					<img
						src={mediaSrc(mod.icon)}
						alt=""
						className="size-6 rounded-md object-cover"
					/>
				) : (
					<Icon icon={tablerGridDots} width="17" height="17" />
				)}
			</RailButton>
			{mod.caseType && (
				<RailButton
					label={`${mod.name} — Case List & Search`}
					active={isCaseListSelected}
					onClick={() => onSelect({ kind: "cases", moduleUuid })}
				>
					<Icon icon={tablerTable} width="16" height="16" />
				</RailButton>
			)}
			{(formIds ?? []).map((formUuid) => (
				<RailFormButton
					key={formUuid}
					moduleUuid={moduleUuid}
					formUuid={formUuid}
				/>
			))}
		</>
	);
});

function RailFormButton({
	moduleUuid,
	formUuid,
}: {
	moduleUuid: Uuid;
	formUuid: Uuid;
}) {
	const form = useForm(formUuid);
	const onSelect = useAppTreeSelection();
	const isSelected = useIsFormSelected(formUuid);
	if (!form) return null;
	return (
		<RailButton
			label={form.name}
			active={isSelected}
			onClick={() => onSelect({ kind: "form", moduleUuid, formUuid })}
		>
			{form.icon ? (
				// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
				<img
					src={mediaSrc(form.icon)}
					alt=""
					className="size-5 rounded object-cover"
				/>
			) : (
				<Icon icon={formTypeIcons[form.type]} width="15" height="15" />
			)}
		</RailButton>
	);
}

function RailButton({
	label,
	active,
	onClick,
	children,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<SimpleTooltip content={label} side="right">
			<button
				type="button"
				onClick={onClick}
				aria-label={label}
				className={`size-11 grid place-items-center rounded-lg transition-colors cursor-pointer ${
					active
						? "bg-nova-violet/[0.15] text-nova-violet-bright shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
						: "text-nova-text-muted hover:text-nova-text-secondary hover:bg-white/[0.05]"
				}`}
			>
				{children}
			</button>
		</SimpleTooltip>
	);
}
