/**
 * The starting-value row of a field whose form opens it with the loaded
 * case's current value.
 *
 * On a one-case followup or close form, every field writing the module's
 * own case type is seeded from that case when the form opens
 * (`writerPreloadsFromLoadedCase`), so there is no starting value to
 * author: the case supplies it. The row says so in place of the editor.
 * A field that still holds an expression there (written before the rail
 * said this, or carried over from another kind) shows it read-only with
 * the truth about it and one way to clear it, because a stored expression
 * that never runs is a promise the form does not keep.
 *
 * The wrapper's `data-field-id` is the slot's key so undo focus and the
 * inspector's element lookup land on this row exactly as they would on the
 * editor it replaces.
 */
"use client";

import {
	INSPECTOR_LABEL_CLS,
	InspectorHint,
} from "@/components/builder/inspector/inspectorChrome";
import { XPathField } from "@/components/builder/XPathField";
import { Button } from "@/components/shadcn/button";
import { useXPathProjection } from "@/lib/doc/hooks/useXPathSlots";
import type { Field, XPathExpression } from "@/lib/domain";
import type {
	FieldEditorComponentProps,
	XPathExpressionKeys,
} from "@/lib/domain/kinds";

export const PRELOADED_VALUE_HINT = "Opens with this case's current value.";
export const DEAD_EXPRESSION_HINT =
	"This expression never runs here. The case's value replaces it when the form opens.";

export function PreloadedValueRow({
	label,
	keyName,
	storedText,
	onRemoveStored,
}: {
	/** The row's label; omitted when a parent control already names it. */
	readonly label?: string;
	/** The slot this row stands in for (`default_value`); becomes `data-field-id`. */
	readonly keyName: string;
	/** The projected text of a stored expression that never runs here. */
	readonly storedText?: string;
	/** Clears the stored expression. Offered only when `storedText` is set. */
	readonly onRemoveStored?: () => void;
}) {
	const hasStored = storedText !== undefined && storedText !== "";
	return (
		<div>
			{label !== undefined && (
				<span className={`${INSPECTOR_LABEL_CLS} mb-1.5 block`}>{label}</span>
			)}
			<div data-field-id={keyName} className="space-y-2">
				<InspectorHint>{PRELOADED_VALUE_HINT}</InspectorHint>
				{hasStored && (
					<>
						<XPathField value={storedText} />
						<InspectorHint>{DEAD_EXPRESSION_HINT}</InspectorHint>
						{onRemoveStored !== undefined && (
							<Button type="button" variant="ghost" onClick={onRemoveStored}>
								Remove expression
							</Button>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * The `default_value` entry's editor on a preloaded writer: the row above,
 * fed from the slot. Removing a stored expression clears the slot through
 * the entry's own `onChange(undefined)`, the same path an emptied XPath
 * editor takes, so the section's activation bookkeeping sees it too.
 */
export function PreloadedDefaultValueEditor<
	F extends Field,
	K extends XPathExpressionKeys<F>,
>({ value, onChange, label, keyName }: FieldEditorComponentProps<F, K>) {
	const projection = useXPathProjection(value as XPathExpression | undefined);
	return (
		<PreloadedValueRow
			label={label}
			keyName={keyName}
			storedText={projection.ok ? projection.text : undefined}
			onRemoveStored={() => onChange(undefined as F[K])}
		/>
	);
}
