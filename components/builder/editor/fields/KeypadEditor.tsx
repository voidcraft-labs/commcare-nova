/**
 * KeypadEditor: a Text question's **Number keypad** switch, over `keypad`.
 *
 * On writes `keypad: "numbers"`; off clears it with `keypad: null`, one
 * `updateField` and one undo step each. The question stays a Text question:
 * its answer is text, so a leading zero or a `+` is kept. The question
 * picker's **Phone number** row inserts the same stored thing.
 *
 * While the switch is off, the `number-keypad` note row says what each
 * platform does with it. Once on, the field inspector's own note row states
 * the same feature for the question (`FieldPlatformNotes`), so it is not
 * said twice.
 *
 * `data-field-id="keypad"` lets undo focus and Playwright find the row.
 */
"use client";

import { useCallback, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { TextField } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

export const KEYPAD_LINE =
	"Workers type on a number keypad. The answer is kept as text, so a leading zero or a + stays.";

export function KeypadEditor({
	field,
	label,
}: FieldEditorComponentProps<TextField, "keypad">) {
	const checked = field.keypad !== undefined;
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	const toggle = useCallback(
		(next: boolean) => {
			const outcome = updateField(field.uuid, "text", {
				keypad: next ? "numbers" : null,
			});
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
		},
		[updateField, field.uuid],
	);
	return (
		<div data-field-id="keypad" className="space-y-2">
			<ToggleRow
				label={label}
				description={KEYPAD_LINE}
				checked={checked}
				onChange={toggle}
			/>
			{!checked && <PlatformNoteRow features={["number-keypad"]} />}
			<RejectionInline message={rejection} />
		</div>
	);
}
