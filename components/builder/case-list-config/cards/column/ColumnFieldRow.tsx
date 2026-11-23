// components/builder/case-list-config/cards/column/ColumnFieldRow.tsx
//
// Shared "field + header" row used by the six field-bearing column
// cards (`plain`, `date`, `phone`, `id-mapping`, `image-map`,
// `interval`). The `calculated` arm has no `field` slot: the
// expression is the source, so it skips this row and renders
// header + expression directly. Factoring the field/header pair
// keeps the per-card body focused on the kind-specific extras (date
// pattern, threshold, mapping table) rather than re-implementing
// the same two inputs six times.
//
// Wraps:
//   - Property picker (`PropertyPicker`) constrained by the kind's
//     `applicableForProperty` predicate. Surfaces an inline error
//     when the resolved property's data type doesn't satisfy the
//     kind: e.g. Late Flag on a text-typed property.
//   - A "From" picker over the case the information is read from: this
//     case, or a case above it through the catalog's parent chain (and the
//     column's own walk, where it names another link). The property picker
//     then lists that case type's properties.
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
// surface (no Expression / Expression provider available) must
// mount its own provider: the top-level `ColumnEditor` handles
// this.

"use client";
import { useId, useState } from "react";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { useEditorVocabulary } from "@/components/builder/shared/editorContext";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { InlineError } from "@/components/builder/shared/primitives/CardShell";
import { PropertyPicker } from "@/components/builder/shared/primitives/PropertyPicker";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { type CaseProperty, type ColumnVia, sameColumnVia } from "@/lib/domain";
import { readCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { propertiesReachedByColumn } from "@/lib/domain/columnRelation";
import { propertyDisplayLabelForName } from "@/lib/domain/propertyDisplay";
import { columnSources } from "../../columnSources";

interface ColumnFieldRowProps {
	/** The column's selected, declared case-property name. */
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
	/** Inline error rows surfaced beneath the picker: typically
	 *  the kind-vs-property-type applicability mismatch hint. */
	readonly errors?: readonly string[];
	/** The walk to the case the column reads; absent for this case. */
	readonly via?: ColumnVia;
	readonly readFrom?: "worker-record";
	readonly showOwner?: "name";
	/** Fired when the author reads from another case: its walk, and the
	 *  property kept where that case has one of the same name, else none. */
	readonly onSourceChange?: (
		via: ColumnVia | undefined,
		field: string,
		readFrom?: "worker-record",
		showOwner?: "name",
	) => void;
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
	via,
	readFrom,
	showOwner,
	onSourceChange,
}: ColumnFieldRowProps) {
	const [editingLink, setEditingLink] = useState(false);
	const [link, setLink] = useState("");
	const [editingName, setEditingName] = useState(false);
	const [propertyName, setPropertyName] = useState("");
	const id = useId();
	const fieldInvalid = errors !== undefined && errors.length > 0;
	const { caseTypes, currentCaseType } = useEditorVocabulary();
	const projectProse = useProseProjection();
	const sources = columnSources(currentCaseType, caseTypes, via);
	const source =
		sources.find(
			(one) => one.readFrom === readFrom && sameColumnVia(one.via, via),
		) ?? sources[0];
	const readCaseType = source.caseType;
	/** What a source offers: the worker's record lists its own properties,
	 *  any other case what the catalog's walk reaches. */
	const sourceProperties = (one: (typeof sources)[number]) =>
		one.readFrom === "worker-record"
			? (caseTypes.find((type) => type.name === one.caseType)?.properties ?? [])
			: propertiesReachedByColumn(one, currentCaseType, caseTypes, field);
	const properties = sourceProperties(source);
	const chooseSource = (key: string | null) => {
		if (key === "add-link") {
			setLink("");
			setEditingLink(true);
			return;
		}
		const next = sources.find((one) => one.key === key);
		if (next === undefined || onSourceChange === undefined) return;
		setEditingLink(false);
		setEditingName(false);
		const keeps = sourceProperties(next).some(
			(property) =>
				property.name === field &&
				(propertyFilter === undefined || propertyFilter(property)),
		);
		onSourceChange(
			next.via,
			keeps ? field : "",
			next.readFrom,
			keeps ? showOwner : undefined,
		);
	};
	const linkValid =
		/^[A-Za-z][A-Za-z0-9_-]*$/.test(link) &&
		(via !== undefined || link !== "user");

	const inheritedHeader = propertyDisplayLabelForName(
		field,
		properties,
		projectProse,
	);
	const usesInheritedHeader = header.trim() === "";
	return (
		<div className="space-y-4 [&_button]:!text-[14px] [&_input]:!text-[14px]">
			{onSourceChange !== undefined && currentCaseType !== undefined ? (
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>From</div>
					<Select value={source?.key ?? "self"} onValueChange={chooseSource}>
						<SelectTrigger
							className="min-h-11 w-full"
							aria-label="Read information from"
						>
							<SelectValue>{source?.label ?? "This case"}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{sources.map((one) => (
								<SelectItem
									key={one.key}
									value={one.key}
									disabled={
										!caseTypes
											.find((type) => type.name === one.caseType)
											?.properties.some(
												(property) => propertyFilter?.(property) ?? true,
											)
									}
									wrap
								>
									{one.label}
								</SelectItem>
							))}
							<SelectItem value="add-link">
								{via === undefined
									? "Choose another link"
									: "Follow another link"}
							</SelectItem>
						</SelectContent>
					</Select>
					{editingLink && (
						<div className="mt-2 space-y-2">
							<label htmlFor={`${id}-link`} className="text-sm">
								Link name on the case
							</label>
							<Input
								id={`${id}-link`}
								value={link}
								onChange={(event) => setLink(event.target.value)}
							/>
							{link && !linkValid && (
								<p className="text-xs text-nova-rose">
									A case link starts with a letter. It can include numbers,
									hyphens and underscores. The first link uses the name saved on
									the case.
								</p>
							)}
							<div className="flex gap-2">
								<Button
									disabled={!linkValid}
									onClick={() => {
										onSourceChange(
											[...(via ?? []), { identifier: link }] as ColumnVia,
											field,
										);
										setEditingLink(false);
									}}
								>
									Use this link
								</Button>
								<Button variant="ghost" onClick={() => setEditingLink(false)}>
									Cancel
								</Button>
							</div>
						</div>
					)}
					<p className="mt-1.5 text-[12px] leading-4 text-nova-text-muted">
						Choose whose information appears in this column.
					</p>
				</div>
			) : null}
			<div>
				<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Information from</div>
				<PropertyPicker
					caseType={readCaseType}
					sourceProperties={properties}
					onCreateNew={
						via === undefined || readCaseType !== undefined
							? undefined
							: () => {
									setPropertyName(field);
									setEditingName(true);
								}
					}
					createNewLabel="Use a property by name"
					value={field === "" ? undefined : field}
					onChange={(next) => {
						if (showOwner && next !== field && onSourceChange)
							onSourceChange(via, next, readFrom);
						else onFieldChange(next);
					}}
					filter={propertyFilter}
					invalid={fieldInvalid}
					ariaLabel="Information from"
				/>
				{editingName && (
					<div className="mt-2 space-y-2">
						<label htmlFor={`${id}-property`} className="text-sm">
							Property name on the related case
						</label>
						<Input
							id={`${id}-property`}
							value={propertyName}
							onChange={(event) => setPropertyName(event.target.value)}
						/>
						<div className="flex gap-2">
							<Button
								disabled={
									!readCasePropertyNameSchema.safeParse(propertyName).success
								}
								onClick={() => {
									onFieldChange(propertyName);
									setEditingName(false);
								}}
							>
								Use this property
							</Button>
							<Button variant="ghost" onClick={() => setEditingName(false)}>
								Cancel
							</Button>
						</div>
					</div>
				)}
				<InlineError errors={errors ?? []} />
				{field === "owner_id" && onSourceChange && (
					<div className="mt-3">
						<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Show owner as</div>
						<Select
							value={showOwner ?? "id"}
							onValueChange={(next) =>
								onSourceChange(
									via,
									field,
									readFrom,
									next === "name" ? "name" : undefined,
								)
							}
						>
							<SelectTrigger aria-label="Show owner as">
								<SelectValue>{showOwner ? "Name" : "ID"}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="name">Name</SelectItem>
								<SelectItem value="id">ID</SelectItem>
							</SelectContent>
						</Select>
					</div>
				)}
			</div>
			<div>
				<div className="mb-2 flex items-baseline justify-between gap-3">
					<div className={INSPECTOR_LABEL_CLS}>Label</div>
					{usesInheritedHeader ? (
						<span className="text-right text-[12px] leading-4 text-nova-text-muted">
							Uses information label
						</span>
					) : null}
				</div>
				<BlurCommitTextInput
					value={usesInheritedHeader ? inheritedHeader : header}
					onCommit={onHeaderChange}
					ariaLabel="Display label"
				/>
			</div>
		</div>
	);
}
