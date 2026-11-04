// components/builder/detail/moduleSettings/CaseListMenuItemSection.tsx
//
// Case list in the menu: whether the menu lists its case list as an entry of
// its own (`Module.caseListMenuItem`, presence the switch), after its forms,
// and the entry's label, icon and spoken label. Every change commits the
// whole entry through one `setCaseListMenuItem` (`{}` on, `null` off, the
// item with its slots when one changes). The switch is disabled with its
// reason, never withheld: while on in a menu with no forms and no submenus
// (the case list is what the menu opens), and where the gate refuses the
// change, with the gate's own sentence (a menu a carried create keeps
// advanced whose list is narrowed reads `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s).

"use client";

import { useCallback, useId } from "react";
import { InlineField } from "@/components/builder/detail/formSettings/InlineField";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useIsBareCaseListModule } from "@/lib/doc/hooks/useModuleIds";
import { useOfferedBatchRefusals } from "@/lib/doc/hooks/useOfferedBatchRefusals";
import { useOwnerPlatformFeatures } from "@/lib/doc/hooks/usePlatformNotes";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import type { CaseListMenuItem } from "@/lib/domain";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import { useCanEdit } from "@/lib/session/hooks";

/** What the entry's platform note can state. */
const MENU_ITEM_NOTE_FEATURES: readonly PlatformFeatureId[] = [
	"case-list-menu-item",
];

export const CASE_LIST_MENU_ITEM_HEADING = "Case list in the menu";
export const CASE_LIST_MENU_ITEM_SWITCH = "Show the case list in this menu";
export const CASE_LIST_MENU_ITEM_LINE =
	"Workers can open the case list on its own, to look up a case without opening a form";
export const CASE_LIST_MENU_ITEM_BARE_LINE =
	"This menu has no forms, so the case list is what it opens. Once it has a form, you can turn this off.";

/** The one mutation that sets or clears the entry. */
export function caseListMenuItemMutation(
	moduleUuid: Uuid,
	item: CaseListMenuItem | null,
): Mutation {
	return { kind: "setCaseListMenuItem", uuid: moduleUuid, item };
}

export function CaseListMenuItemSection({
	moduleUuid,
}: {
	readonly moduleUuid: Uuid;
}) {
	const module = useModule(moduleUuid);
	const bare = useIsBareCaseListModule(moduleUuid);
	const canEdit = useCanEdit();
	const { commitMany, inline } = useBlueprintMutations();
	const headingId = useId();
	const notes = useOwnerPlatformFeatures(
		{ kind: "module", moduleUuid },
		MENU_ITEM_NOTE_FEATURES,
	);
	const item = module?.caseListMenuItem;
	const on = item !== undefined;
	const plan = useCallback(
		(doc: BlueprintDoc) => ({
			toggle: [
				caseListMenuItemMutation(
					moduleUuid,
					doc.modules[moduleUuid]?.caseListMenuItem === undefined ? {} : null,
				),
			],
		}),
		[moduleUuid],
	);
	const gate = useOfferedBatchRefusals<"toggle">(
		plan,
		canEdit && module?.caseType !== undefined && !bare,
	);

	if (module === undefined || module.caseType === undefined) return null;
	const switchRefusal =
		on && bare ? CASE_LIST_MENU_ITEM_BARE_LINE : gate.toggle;
	const setItem = (next: CaseListMenuItem | null) =>
		commitMany([caseListMenuItemMutation(moduleUuid, next)]);
	/* Each slot change writes the whole entry with the other slots as they
	 * are; an empty slot is absent, never stored empty. */
	const withSlot = <K extends keyof CaseListMenuItem>(
		key: K,
		value: CaseListMenuItem[K] | undefined,
	): CaseListMenuItem => {
		const { [key]: _previous, ...rest } = item ?? {};
		return value === undefined ? rest : { ...rest, [key]: value };
	};

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-3 border-t border-nova-border pt-5"
			data-case-list-menu-item={on ? "true" : "false"}
		>
			<h3
				id={headingId}
				className="text-sm font-medium text-nova-text-secondary"
			>
				{CASE_LIST_MENU_ITEM_HEADING}
			</h3>
			<ToggleRow
				label={CASE_LIST_MENU_ITEM_SWITCH}
				description={CASE_LIST_MENU_ITEM_LINE}
				checked={on}
				onChange={(next) => {
					if (next === on) return;
					setItem(next ? {} : null);
				}}
				disabledReason={switchRefusal}
			/>
			<PlatformNoteRow features={notes} />
			{on && (
				<div className="space-y-3">
					{canEdit ? (
						<InlineField
							label="Menu item label"
							value={item.label ?? ""}
							placeholder={module.name}
							onChange={(value) =>
								inline.commitMany([
									caseListMenuItemMutation(
										moduleUuid,
										withSlot(
											"label",
											value.trim().length > 0 ? value.trim() : undefined,
										),
									),
								])
							}
						/>
					) : (
						<p className="text-[13px] text-nova-text-secondary">
							Menu item label: {item.label ?? module.name}
						</p>
					)}
					<div>
						<span className="mb-1 block text-xs text-nova-text-muted">
							Icon
						</span>
						<SingleAssetSlot
							value={item.icon}
							kind="image"
							iconLibrary="module"
							slotKey={`caselist:${moduleUuid}:icon`}
							ariaLabel="Case list menu item icon"
							onChange={(icon) => setItem(withSlot("icon", icon))}
						/>
					</div>
					<div>
						<span className="mb-1 block text-xs text-nova-text-muted">
							Spoken label
						</span>
						<SingleAssetSlot
							value={item.audioLabel}
							kind="audio"
							slotKey={`caselist:${moduleUuid}:audioLabel`}
							ariaLabel="Case list menu item spoken label"
							onChange={(audioLabel) =>
								setItem(withSlot("audioLabel", audioLabel))
							}
						/>
					</div>
				</div>
			)}
		</section>
	);
}
