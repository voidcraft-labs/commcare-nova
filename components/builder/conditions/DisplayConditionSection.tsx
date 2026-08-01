// components/builder/conditions/DisplayConditionSection.tsx
//
// The module- and form-settings row for a display condition: what it
// currently does, plus Add / Edit / Clear. Editing opens the centre
// canvas at the item's own condition URL: the settings popover is too
// narrow for a recursive condition, and the URL makes the editor
// deep-linkable and previewable.

"use client";

import { ConditionSlotSetting } from "@/components/builder/shared/ConditionSlotSetting";
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
	if (resolved === null) return null;
	const { copy, condition, commit, caseTypes, currentCaseType } = resolved;

	const openEditor = () => {
		onNavigateAway?.();
		if (target.kind === "module") {
			navigate.openModuleCondition(target.moduleUuid);
			return;
		}
		navigate.openFormCondition(target.moduleUuid, target.formUuid);
	};

	return (
		<ConditionSlotSetting
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
	);
}
