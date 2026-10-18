// components/builder/conditions/DisplayConditionSection.tsx
//
// The module- and form-settings rows for where the item shows: the "Show on
// the menu" switch, and the display condition that applies while it is on
// the menu, with what it currently does plus Add / Edit / Clear. Editing
// opens the centre canvas at the item's own condition URL: the settings
// popover is too narrow for a recursive condition, and the URL makes the
// editor deep-linkable and previewable.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import { useId, useState } from "react";
import { ConditionSlotSetting } from "@/components/builder/shared/ConditionSlotSetting";
import { Switch } from "@/components/shadcn/switch";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import {
	type DisplayConditionTarget,
	useDisplayConditionCarrier,
} from "./useDisplayConditionCarrier";

export function DisplayConditionSection({
	target,
	onNavigateAway,
}: {
	readonly target: DisplayConditionTarget;
	/** Dismiss the settings popover that hosts this row. Opening the
	 *  editor is a screen change, and the popover's open-state survives
	 *  it (its owner is hidden, not unmounted), so it would otherwise
	 *  still be sitting open on return. */
	readonly onNavigateAway?: () => void;
}) {
	const resolved = useDisplayConditionCarrier(target);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const switchId = useId();
	/* A refusal answers one switch on one item in one state. It clears when
	 * the section moves to another item, or when the flag changes by any
	 * route, so it never speaks for a state it was not about. */
	const [refusal, setRefusal] = useState<
		{ readonly about: string; readonly message: string } | undefined
	>(undefined);
	if (resolved === null) return null;
	const {
		copy,
		condition,
		expressionContext,
		commit,
		hiddenFromMenu,
		setHiddenFromMenu,
		caseTypes,
		currentCaseType,
	} = resolved;
	const refusalAbout = `${target.kind === "module" ? target.moduleUuid : target.formUuid}:${hiddenFromMenu}`;
	if (refusal !== undefined && refusal.about !== refusalAbout)
		setRefusal(undefined);

	const openEditor = () => {
		onNavigateAway?.();
		if (target.kind === "module") {
			navigate.openModuleCondition(target.moduleUuid);
			return;
		}
		navigate.openFormCondition(target.moduleUuid, target.formUuid);
	};

	return (
		<div className="space-y-3">
			<div className="space-y-2">
				<label
					htmlFor={switchId}
					className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-white/[0.05] bg-white/[0.03] px-2.5 py-1.5 transition-colors hover:border-white/[0.08] has-[:disabled]:cursor-default"
				>
					<span className="min-w-0 flex-1">
						<span className="block text-[13px] text-nova-text">
							{copy.menuSwitchLabel}
						</span>
						<span className="mt-0.5 block text-[13px] leading-snug text-nova-text-muted">
							{hiddenFromMenu ? copy.offTheMenuNote : copy.onTheMenuNote}
						</span>
					</span>
					<Switch
						id={switchId}
						checked={!hiddenFromMenu}
						disabled={!canEdit}
						onCheckedChange={(shown) => {
							const outcome = setHiddenFromMenu(!shown);
							setRefusal(
								outcome.ok
									? undefined
									: {
											about: refusalAbout,
											message: outcome.messages.join(" "),
										},
							);
						}}
					/>
				</label>
				{refusal !== undefined && refusal.about === refusalAbout && (
					<div
						role="alert"
						className="flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
					>
						<Icon
							icon={tablerAlertCircle}
							width="16"
							height="16"
							className="mt-0.5 shrink-0 text-nova-rose"
						/>
						<span>{refusal.message}</span>
					</div>
				)}
			</div>
			<ConditionSlotSetting
				expressionContext={expressionContext}
				title={copy.settingTitle}
				description={copy.settingDescription}
				value={condition}
				onChange={commit}
				onEdit={openEditor}
				canEdit={canEdit}
				alwaysSummary={copy.alwaysSummary}
				clearLabel={copy.clearLabel}
				clearTitle={copy.clearTitle}
				clearConsequence={copy.clearConsequence}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				caseDataScope={copy.caseDataScope}
			/>
		</div>
	);
}
