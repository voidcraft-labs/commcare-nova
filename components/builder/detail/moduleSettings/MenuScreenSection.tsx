// components/builder/detail/moduleSettings/MenuScreenSection.tsx
//
// Where a menu's forms show: the switch that has a menu show its forms in
// the menu above (`Module.formsInMenuAbove`, presence the switch), with its
// line and the lines that follow from it. The switch commits
// `setModuleFormsInMenuAboveMutation` through the inline gate and is never
// hidden: where the gate refuses the change (a menu that is a link's target,
// holds an entry point or searches), it is disabled with the gate's own
// sentence (`useOfferedBatchRefusals`).

"use client";

import { useCallback, useId, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { updateModuleMutation } from "@/lib/doc/addModuleMutation";
import { setModuleFormsInMenuAboveMutation } from "@/lib/doc/displayConditionMutations";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useMenuScreenSource } from "@/lib/doc/hooks/useMenuScreenSource";
import { useOfferedBatchRefusals } from "@/lib/doc/hooks/useOfferedBatchRefusals";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { menuScreenOf, moduleShowsFormsInMenuAbove } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import {
	MENU_SCREEN_HEADING,
	MENU_SCREEN_SWITCH,
	menuScreenLines,
} from "./menuScreenCopy";

export function MenuScreenSection({
	moduleUuid,
}: {
	readonly moduleUuid: Uuid;
}) {
	const module = useModule(moduleUuid);
	const { firstMenuLayout, formMenuLayout } = useAppSettings();
	const source = useMenuScreenSource();
	const canEdit = useCanEdit();
	const { inline } = useBlueprintMutations();
	const headingId = useId();
	/* A refusal the commit itself returned (a peer's edit landed between the
	 * review and the press), kept beside the switch until the next press. */
	const [refused, setRefused] = useState<string | undefined>();
	const on = moduleShowsFormsInMenuAbove(module);
	const plan = useCallback(
		(doc: BlueprintDoc) => ({
			grid: [
				updateModuleMutation(moduleUuid, {
					menuLayout:
						doc.modules[moduleUuid]?.menuLayout === "grid" ? null : "grid",
				}),
			],
			toggle: [
				setModuleFormsInMenuAboveMutation(
					moduleUuid,
					!moduleShowsFormsInMenuAbove(doc.modules[moduleUuid]),
				),
			],
		}),
		[moduleUuid],
	);
	const gate = useOfferedBatchRefusals<"toggle" | "grid">(
		plan,
		canEdit && module !== undefined,
	);

	if (module === undefined) return null;
	const screen = menuScreenOf(source, moduleUuid);
	const usesIndividual =
		formMenuLayout === "individual" && screen.kind === "menu";
	const { line, added } = menuScreenLines(source, moduleUuid);

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-3 border-t border-nova-border pt-5"
			data-menu-screen={on ? "above" : "own"}
		>
			<h3
				id={headingId}
				className="text-sm font-medium text-nova-text-secondary"
			>
				{MENU_SCREEN_HEADING}
			</h3>
			<ToggleRow
				label={MENU_SCREEN_SWITCH}
				description={line}
				checked={on}
				onChange={(next) => {
					if (next === on) return;
					const outcome = inline.commitMany([
						setModuleFormsInMenuAboveMutation(moduleUuid, next),
					]);
					setRefused(outcome.ok ? undefined : outcome.messages[0]);
				}}
				disabledReason={gate.toggle}
			/>
			{/* A menu listing another menu's forms holds no layout of its own:
			 * it follows Other menus in App settings. */}
			{module.formsFromMenu === undefined && (
				<ToggleRow
					label="Use a grid"
					checked={module.menuLayout === "grid"}
					description={
						usesIndividual
							? screen.moduleUuid === moduleUuid
								? "Show this menu’s choices as tiles."
								: `Show the choices in ${source.modules[screen.moduleUuid]?.name} as tiles, including the forms from this menu.`
							: screen.kind === "first-menu"
								? `These forms appear on the first menu, which uses ${firstMenuLayout === "grid" ? "a grid" : "a list"}. This choice takes effect below the first menu when Other menus is set to Choose per menu.`
								: `The app currently shows other menus as ${formMenuLayout === "grid" ? "grids" : "lists"}. This choice takes effect when Other menus is set to Choose per menu.`
					}
					disabledReason={
						!canEdit
							? "A Project editor can change the menu layout."
							: gate.grid
					}
					onChange={(next) => {
						const result = inline.commitMany([
							updateModuleMutation(moduleUuid, {
								menuLayout: next ? "grid" : null,
							}),
						]);
						setRefused(result.ok ? undefined : result.messages[0]);
					}}
				/>
			)}
			{refused !== undefined && (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					{refused}
				</p>
			)}
			{added.length > 0 && (
				<ul className="space-y-1 text-[13px] leading-relaxed text-nova-text-muted">
					{added.map((sentence) => (
						<li key={sentence}>{sentence}</li>
					))}
				</ul>
			)}
		</section>
	);
}
