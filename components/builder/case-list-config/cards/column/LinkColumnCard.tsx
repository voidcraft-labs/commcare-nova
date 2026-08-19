// components/builder/case-list-config/cards/column/LinkColumnCard.tsx
//
// Renders the `link` Column kind: the cell shows a short label that
// opens whatever address the property holds.
//
// Slots:
//   - `field`: case-property name, filtered to text-shaped properties
//     (an address is text; there is no url property type).
//   - `header`: the column's title.
//   - `linkText`: what the cell itself says. One string for every app
//     language — the wire has nowhere to put a translated one, and the
//     card says so rather than leaving it to be discovered.
//
// The two CommCare limits are stated here, at the moment the author is
// deciding, rather than in a doc they may never open.

"use client";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import type { CaseProperty, Column } from "@/lib/domain";
import { columnKindAcceptsPropertyType, linkColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

/** The gate's own accept-set: unknown-typed properties are
 *  admissible, so the dropdown offers them (see `DateColumnCard`). */
const acceptsLinkColumn = (p: CaseProperty) =>
	columnKindAcceptsPropertyType("link", p.data_type);

interface LinkColumnCardProps {
	readonly value: Extract<Column, { kind: "link" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function LinkColumnCard({
	value,
	onChange,
	errors,
}: LinkColumnCardProps) {
	const build = (next: Partial<Extract<Column, { kind: "link" }>>) =>
		onChange(
			linkColumn(
				value.uuid,
				next.field ?? value.field,
				next.header ?? value.header,
				next.linkText ?? value.linkText,
				slotsFrom(value),
			),
		);
	return (
		<div className="space-y-3">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={(field) => build({ field })}
				header={value.header}
				onHeaderChange={(header) => build({ header })}
				propertyFilter={acceptsLinkColumn}
				errors={errors}
			/>
			<div>
				<div className={`${INSPECTOR_LABEL_CLS} mb-1.5`}>Link text</div>
				{/* Late commit, not per keystroke. A link has to say something,
				 *  so `linkText` is the one column string the schema requires
				 *  to be non-empty — and a per-keystroke commit would refuse
				 *  the moment the author selects the old wording and starts
				 *  replacing it. Committing on blur means the empty box is
				 *  only ever a draft, and clearing it outright puts the
				 *  previous wording back rather than saving a link with no
				 *  label. */}
				<BlurCommitTextInput
					value={value.linkText}
					onCommit={(next) => {
						if (next.trim() === "") return;
						build({ linkText: next });
					}}
					placeholder="for example, Photo"
					ariaLabel="Link text"
				/>
				<p className="mt-1.5 text-xs leading-relaxed text-nova-text-muted">
					Every row shows this same wording. It stays in one language, and
					CommCare Android shows the address as plain text rather than a link.
				</p>
			</div>
		</div>
	);
}

/** Re-extract the column's optional common slots so each builder call
 *  threads through them verbatim. */
function slotsFrom(value: Extract<Column, { kind: "link" }>): {
	sort?: typeof value.sort;
	visibleInList?: typeof value.visibleInList;
	visibleInDetail?: typeof value.visibleInDetail;
	tile?: typeof value.tile;
} {
	return {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
		tile: value.tile,
	};
}
