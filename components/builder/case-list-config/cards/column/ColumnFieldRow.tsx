// components/builder/case-list-config/cards/column/ColumnFieldRow.tsx
//
// Shared "field + header" row used by the field-bearing column
// cards (`plain`, `date`, `phone`, `id-mapping`, `interval`). The
// `calculated` arm has no `field` slot — the expression is the
// source — so it skips this row and renders header + expression
// directly. Factoring the field/header pair keeps the per-card
// body focused on the kind-specific extras (date pattern,
// threshold, mapping table) rather than re-implementing the same
// two inputs five times.
//
// Wraps:
//   - Property picker (`PropertyPicker`) constrained by the kind's
//     `applicableForProperty` predicate. Surfaces an inline error
//     when the resolved property's data type doesn't satisfy the
//     kind — e.g. Late Flag on a text-typed property.
//   - Header text input via the shared `BlurCommitTextInput`
//     primitive at `primitives/BlurCommitTextInput.tsx`. Plain
//     text; commits on blur. CommCare allows any header string at
//     the wire layer, so the row enforces no client-side rejection.
//
// Validity: per-row applicability errors flow through the
// `errors` prop into the inline error surface. The surrounding
// card mounts inside `PredicateEditProvider` so the
// `PropertyPicker` reads `currentCaseType` from the same context
// that drives the predicate / expression editors. A column-only
// surface (no Predicate / Expression provider available) must
// mount its own provider — the top-level `ColumnEditor` handles
// this.

"use client";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import { PropertyPicker } from "@/components/builder/shared/primitives/PropertyPicker";
import type { CaseProperty } from "@/lib/domain";

interface ColumnFieldRowProps {
	/** The column's selected case-property name. Empty string when
	 *  unset; the picker surfaces a placeholder in that case. */
	readonly field: string;
	/** Fired when the user picks a property from the dropdown. */
	readonly onFieldChange: (next: string) => void;
	/** The column's display header text. Empty string is allowed at
	 *  the schema layer; the surrounding wire emitter substitutes
	 *  the property name when no header is set. */
	readonly header: string;
	/** Fired when the user commits a new header on blur. */
	readonly onHeaderChange: (next: string) => void;
	/** Optional dropdown filter narrowing the picker's content
	 *  (text-shaped for Phone, date-typed for Date / Interval).
	 *  Plain / ID-Mapping pass no filter so every property
	 *  surfaces. */
	readonly propertyFilter?: (p: CaseProperty) => boolean;
	/** Inline error rows surfaced beneath the picker — typically
	 *  the kind-vs-property-type applicability mismatch hint. */
	readonly errors?: readonly string[];
}

/**
 * Field + header pair shared by every column card. The picker
 * surfaces the kind's applicable properties; the header input
 * commits on blur.
 */
export function ColumnFieldRow({
	field,
	onFieldChange,
	header,
	onHeaderChange,
	propertyFilter,
	errors,
}: ColumnFieldRowProps) {
	const fieldInvalid = errors !== undefined && errors.length > 0;
	return (
		<div className="space-y-2">
			<div>
				<div className="mb-1.5 text-[11px] font-medium text-nova-text-muted">
					Information from
				</div>
				<PropertyPicker
					value={field === "" ? undefined : field}
					onChange={onFieldChange}
					filter={propertyFilter}
					invalid={fieldInvalid}
					displayLabels
					ariaLabel="Information from"
				/>
				<InlineError errors={errors ?? []} />
			</div>
			<div>
				<div className="mb-1.5 text-[11px] font-medium text-nova-text-muted">
					Label
				</div>
				<BlurCommitTextInput
					value={header}
					onCommit={onHeaderChange}
					placeholder="Label shown in the app"
					ariaLabel="Display label"
				/>
			</div>
		</div>
	);
}
