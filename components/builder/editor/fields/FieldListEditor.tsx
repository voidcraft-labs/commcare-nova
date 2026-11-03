/**
 * FieldListEditor: a group's **Show on one screen** switch, over `fieldList`.
 *
 * On writes `fieldList: true`; off clears it with `fieldList: null`, one
 * `updateField` and one undo step each. A group that holds a repeat whose rows
 * workers add, at any depth, can't be shown on one screen (the commit gate's
 * `FIELD_LIST_USER_REPEAT`; CommCare adds a repeat's rows only from a screen of
 * its own), so the switch is off and says why rather than inviting a refusal.
 *
 * While the switch is off, the `question-pages` note row says what Web Apps
 * does with it. Once on, the field inspector's own note row states the same
 * feature for the group (`FieldPlatformNotes`), so it is not said twice.
 *
 * `data-field-id="fieldList"` lets undo focus and Playwright find the row.
 */
"use client";

import { useCallback, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useHoldsUserRepeat } from "@/lib/doc/hooks/useHoldsUserRepeat";
import type { GroupField } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

export const FIELD_LIST_LINE =
	"On Android, these questions show together on one screen.";
export const FIELD_LIST_USER_REPEAT_REASON =
	"This group holds a repeat whose rows workers add, which can't share a screen with other questions.";

export function FieldListEditor({
	field,
	label,
}: FieldEditorComponentProps<GroupField, "fieldList">) {
	const checked = field.fieldList === true;
	const holdsUserRepeat = useHoldsUserRepeat(field.uuid);
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	const toggle = useCallback(
		(next: boolean) => {
			const outcome = updateField(field.uuid, "group", {
				fieldList: next ? true : null,
			});
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
		},
		[updateField, field.uuid],
	);
	return (
		<div data-field-id="fieldList" className="space-y-2">
			<ToggleRow
				label={label}
				description={FIELD_LIST_LINE}
				checked={checked}
				onChange={toggle}
				disabledReason={
					!checked && holdsUserRepeat
						? FIELD_LIST_USER_REPEAT_REASON
						: undefined
				}
			/>
			{!checked && <PlatformNoteRow features={["question-pages"]} />}
			<RejectionInline message={rejection} />
		</div>
	);
}
