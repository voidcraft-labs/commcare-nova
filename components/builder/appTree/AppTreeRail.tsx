/**
 * AppTreeRail: the structure sidebar's collapsed state: a slim icon
 * rail instead of nothing. Every top-level destination stays one
 * click away: module screens, each case-typed module's Case List &
 * Search workspace, and every form, so collapsing the tree trades
 * width for labels, never for reach.
 *
 * Rows mirror the expanded tree's order: module tile, then its
 * case-list node, then its forms, separated per module. Active
 * destination carries the violet treatment; hover reveals the name
 * via tooltip.
 *
 * ## The scroll column hides its native scrollbar, and the arithmetic is why
 *
 * The app-wide reserved gutter (`globals.css`, so a growing panel never
 * shifts its layout) is 11px. The rail is 56px with a 1px border, and 44px
 * is the one control size. 55 minus 11 leaves EXACTLY 44, so the icon column
 * has no slack left to center in: every destination lands flush against the
 * window edge, 5.5px left of the collapse and footer icons that sit outside
 * the scroller. Widening the rail and shrinking the control are both off
 * the table, so the scrollbar is the thing that goes, and the edge fades
 * below say "there is more this way" in its place.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerLayoutSidebarLeftExpand from "@iconify-icons/tabler/layout-sidebar-left-expand";
import tablerSettings from "@iconify-icons/tabler/settings";
import tablerTable from "@iconify-icons/tabler/table";
import { memo, useCallback, useState } from "react";
import { useAppTreeSelection } from "@/components/builder/appTree/useAppTreeSelection";
import { useLocalizedText } from "@/components/builder/localization/BuilderLocalizationProvider";
import { ProjectMediaImage } from "@/components/builder/media/ProjectMediaResource";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useFormIds, useModuleIds } from "@/lib/doc/hooks/useModuleIds";
import { makeTranslationUnitId, type Uuid } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import {
	useIsCaseListSelected,
	useIsFormSelected,
	useLocation,
	useNavigate,
} from "@/lib/routing/hooks";
import { APP_SETUP_LABEL, PROJECT_DATA_LABEL } from "@/lib/routing/types";
import { selectableIconCls } from "@/lib/styles";

/** How far the reachable-content fade reaches in from each scroll edge. */
const SCROLL_FADE = "24px";

/** The mask that replaces the removed scrollbar. It is drawn on the
 *  scrollport, not the content, so the softened band stays at the visible
 *  edge as the rail scrolls. An edge with nothing past it keeps its hard
 *  stop, so a rail that fits dims nothing. */
function edgeFadeMask(top: boolean, bottom: boolean): string | undefined {
	if (!top && !bottom) return undefined;
	const enter = top ? SCROLL_FADE : "0px";
	const leave = bottom ? SCROLL_FADE : "0px";
	return `linear-gradient(to bottom, transparent 0, #000 ${enter}, #000 calc(100% - ${leave}), transparent 100%)`;
}

/** Which edges have content past them. Both observers are load-bearing:
 *  the scrollport resizes with the window, while its content resizes when a
 *  module or form lands, and either one changes what is still out of view. */
function useScrollEdges() {
	const [edges, setEdges] = useState({ top: false, bottom: false });
	const bindScroller = useCallback((node: HTMLDivElement | null) => {
		if (node === null) return;
		const measure = () => {
			const top = node.scrollTop > 1;
			const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
			setEdges((current) =>
				current.top === top && current.bottom === bottom
					? current
					: { top, bottom },
			);
		};
		measure();
		node.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		if (node.firstElementChild !== null)
			observer.observe(node.firstElementChild);
		return () => {
			node.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, []);
	return { edges, bindScroller };
}

export function AppTreeRail({ onExpand }: { onExpand: () => void }) {
	const moduleIds = useModuleIds();
	const { edges, bindScroller } = useScrollEdges();
	const mask = edgeFadeMask(edges.top, edges.bottom);
	return (
		<aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-nova-border-bright bg-nova-deep">
			<div
				className="grid h-16 w-full shrink-0 place-items-center border-b border-nova-border"
				data-builder-secondary-header="structure-rail"
			>
				<SimpleTooltip content="Expand structure" side="right">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={onExpand}
						aria-label="Expand structure sidebar"
						data-builder-sidebar-toggle="expand-structure"
					>
						<Icon icon={tablerLayoutSidebarLeftExpand} width="18" height="18" />
					</Button>
				</SimpleTooltip>
			</div>
			<div
				ref={bindScroller}
				className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-gutter:auto] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
			>
				<div className="flex flex-col items-center gap-1 py-2">
					{moduleIds.map((moduleUuid) => (
						<RailModuleGroup key={moduleUuid} moduleUuid={moduleUuid} />
					))}
				</div>
			</div>
			{/* The configuration workspaces keep their own footer cell rather
			 *  than joining the module groups above: collapsing the tree trades
			 *  width for labels, never for the distinction between this app's
			 *  content, its administration, and the project's shared data. */}
			<div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-nova-border py-2">
				<AppSetupRailButton />
				<ProjectDataRailButton />
			</div>
		</aside>
	);
}

function AppSetupRailButton() {
	const navigate = useNavigate();
	const loc = useLocation();
	return (
		<RailButton
			label={APP_SETUP_LABEL}
			active={loc.kind === "app-setup"}
			onClick={() => navigate.openAppSetup()}
		>
			<Icon icon={tablerSettings} width="17" height="17" />
		</RailButton>
	);
}

function ProjectDataRailButton() {
	const navigate = useNavigate();
	const loc = useLocation();
	return (
		<RailButton
			label={PROJECT_DATA_LABEL}
			active={loc.kind === "project-data"}
			onClick={() => navigate.openProjectData()}
		>
			<Icon icon={tablerTable} width="17" height="17" />
		</RailButton>
	);
}

const RailModuleGroup = memo(function RailModuleGroup({
	moduleUuid,
}: {
	moduleUuid: Uuid;
}) {
	const mod = useModule(moduleUuid);
	const localizedModuleName = useLocalizedText(
		makeTranslationUnitId("module", moduleUuid, "name"),
	);
	const formIds = useFormIds(moduleUuid);
	const onSelect = useAppTreeSelection();
	const loc = useLocation();
	const isCaseListSelected = useIsCaseListSelected(moduleUuid);
	/* Exact-module selection (not the descendant-inclusive predicate):
	 * the rail highlights the precise destination, so a form screen
	 * lights its form icon, not the parent module's. */
	const isModuleScreen = loc.kind === "module" && loc.moduleUuid === moduleUuid;

	if (!mod) return null;
	const moduleName = localizedModuleName ?? mod.name;

	return (
		<>
			<div className="w-7 h-px bg-nova-border my-1" aria-hidden="true" />
			<RailButton
				label={moduleName}
				active={isModuleScreen}
				onClick={() => onSelect({ kind: "module", moduleUuid })}
			>
				{mod.icon ? (
					<ProjectMediaImage
						assetId={mod.icon}
						alt=""
						className="size-6 rounded-md object-cover"
					/>
				) : (
					<Icon icon={tablerGridDots} width="17" height="17" />
				)}
			</RailButton>
			{mod.caseType && (
				<RailButton
					label={`${moduleName}, case list and search`}
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
	const localizedFormName = useLocalizedText(
		makeTranslationUnitId("form", formUuid, "name"),
	);
	const onSelect = useAppTreeSelection();
	const isSelected = useIsFormSelected(formUuid);
	if (!form) return null;
	const formName = localizedFormName ?? form.name;
	return (
		<RailButton
			label={formName}
			active={isSelected}
			onClick={() => onSelect({ kind: "form", moduleUuid, formUuid })}
		>
			{form.icon ? (
				<ProjectMediaImage
					assetId={form.icon}
					alt=""
					className="size-5 rounded-sm object-cover"
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
				className={selectableIconCls(active)}
			>
				{children}
			</button>
		</SimpleTooltip>
	);
}
