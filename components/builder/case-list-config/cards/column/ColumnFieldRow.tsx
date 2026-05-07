// components/builder/case-list-config/cards/column/ColumnFieldRow.tsx
//
// Shared "field + header" row used by every column card. The
// pairing surfaces on every `ColumnKind` (the column schema's
// `field: string` + `header: string` are required on every arm),
// so factoring the row keeps the per-card body focused on the
// kind-specific extras (date pattern, threshold, mapping table,
// etc.) rather than re-implementing the same two inputs seven
// times.
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
import type { CaseProperty } from "@/lib/domain";
import { BlurCommitTextInput } from "../../primitives/BlurCommitTextInput";
import { InlineError } from "../../primitives/CardShell";
import { PropertyPicker } from "../../primitives/PropertyPicker";

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
	 *  (text-shaped for Phone, date-typed for Date / Late Flag /
	 *  Time-Since-Until). Plain / ID-Mapping / Search-Only pass
	 *  no filter so every property surfaces. */
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
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Property
				</div>
				<PropertyPicker
					value={field === "" ? undefined : field}
					onChange={onFieldChange}
					filter={propertyFilter}
					invalid={fieldInvalid}
				/>
				<InlineError errors={errors ?? []} />
			</div>
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Header
				</div>
				<BlurCommitTextInput
					value={header}
					onCommit={onHeaderChange}
					placeholder="Header text"
					ariaLabel="Column header"
				/>
			</div>
		</div>
	);
}
