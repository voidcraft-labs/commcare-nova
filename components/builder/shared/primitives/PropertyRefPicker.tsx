// components/builder/shared/primitives/PropertyRefPicker.tsx
//
// Property picker for slots whose schema is a PropertyRef directly
// (`match.property`, `multi-select-contains.property`, and
// `within-distance.property`) and for the prop arm inside TermCard.
// ValueExpression slots use ExpressionPicker, which edits every term
// source and calculated expression instead of reducing them to a badge.
//
// Round-trip contract:
//   - `via: RelationPath` is preserved verbatim across property
//     name changes. The picker's `setProperty` callback rebuilds
//     via `prop(caseType, name, via)` (three-arg builder), so a
//     saved relation walk doesn't disappear on the user's first
//     dropdown click. A secondary "Uses information from" disclosure
//     mounts the complete RelationPathBuilder; non-self paths open by
//     default while the common current-case path stays compact.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerRoute from "@iconify-icons/tabler/route";
import { useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import type { CaseProperty } from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";
import {
	type PropertyRef,
	prop,
	selfPath,
	XML_ELEMENT_NAME_PATTERN,
} from "@/lib/domain/predicate";
import {
	type ExpressionChangeAdmission,
	usePredicateEditContext,
} from "../editorContext";
import { resolveRelationDestination } from "../relationDestination";
import { PropertyPicker } from "./PropertyPicker";
import { RelationPathBuilder } from "./RelationPathBuilder";

interface PropertyRefPickerProps extends PropertyRefPickerSharedProps {
	readonly mode: "property-only";
	readonly value: PropertyRef;
	readonly onChange: (next: PropertyRef) => void;
}

interface PropertyRefPickerSharedProps {
	/** Optional property filter narrowing the dropdown's content
	 *  (e.g. multi_select-only for `multi-select-contains`,
	 *  ordered-only for `between`). When undefined, every
	 *  property shows. */
	readonly filter?: (property: CaseProperty) => boolean;
	/** Accessibility label for the dropdown trigger / replace button. */
	readonly ariaLabel?: string;
	/** Surfaces the picker in an error state when the surrounding
	 *  card's validity index has errors at this slot. */
	readonly invalid?: boolean;
	/** Optional whole-rule verdict for an exact property or relationship edit. */
	readonly admitChange?: (next: PropertyRef) => ExpressionChangeAdmission;
}

/**
 * Property picker that round-trips every PropertyRef shape, including
 * optional `via: RelationPath` walks. Rebuilding flows through prop()'s
 * three-argument form so a relation path survives every property edit.
 */
export function PropertyRefPicker(props: PropertyRefPickerProps) {
	const {
		filter,
		ariaLabel = "Case information",
		invalid = false,
		admitChange,
	} = props;
	return (
		<PropertyRefEditor
			value={props.value}
			onChange={props.onChange}
			filter={filter}
			invalid={invalid}
			ariaLabel={ariaLabel}
			admitChange={admitChange}
		/>
	);
}

interface PropertyRefEditorProps extends PropertyRefPickerSharedProps {
	readonly value: PropertyRef;
	readonly onChange: (next: PropertyRef) => void;
}

/** Property + relation controls for a PropertyRef. The property dropdown is
 * rebound to the relation destination, while an unresolved saved path shows
 * the current property as unavailable instead of falling back to the wrong
 * (origin) case type. */
function PropertyRefEditor({
	value,
	onChange,
	filter,
	ariaLabel = "Case information",
	invalid = false,
	admitChange,
}: PropertyRefEditorProps) {
	const ctx = usePredicateEditContext();
	const relation = value.via ?? selfPath();
	const destination = resolveRelationDestination(
		relation,
		value.caseType,
		ctx.caseTypes,
	);
	const summary = relationSummary(relation, value.caseType, ctx.caseTypes);
	const hasRelationWalk = value.via !== undefined && value.via.kind !== "self";
	const [relationOpen, setRelationOpen] = useState(hasRelationWalk);
	const showRelationControl = hasRelationWalk || relationOpen;

	const setProperty = (name: string) => {
		onChange(
			value.via === undefined
				? prop(value.caseType, name)
				: prop(value.caseType, name, value.via),
		);
	};

	return (
		<div className="min-w-0 space-y-2">
			<PropertyPicker
				value={value.property || undefined}
				onChange={setProperty}
				caseType={destination ?? ""}
				filter={filter}
				admit={(property) =>
					admitChange?.(
						value.via === undefined
							? prop(value.caseType, property.name)
							: prop(value.caseType, property.name, value.via),
					) ?? { admitted: true }
				}
				invalid={invalid}
				ariaLabel={ariaLabel}
				footerAction={
					showRelationControl
						? undefined
						: {
								label: "Use information from another case",
								description: "Choose a parent, child, or linked case",
								icon: tablerRoute,
								onSelect: () => setRelationOpen(true),
							}
				}
			/>

			{showRelationControl && (
				<Collapsible open={relationOpen} onOpenChange={setRelationOpen}>
					<CollapsibleTrigger className="group flex h-auto min-h-11 w-full cursor-pointer items-start gap-2 whitespace-normal rounded-lg border border-white/[0.06] bg-nova-deep/30 px-3 py-2 text-left transition-colors hover:border-nova-violet/30">
						<Icon
							icon={tablerRoute}
							className="mt-0.5 size-4 shrink-0 text-nova-text-muted"
						/>
						<span className="min-w-0 flex-1">
							<span className="block text-xs text-nova-text-muted">
								Uses information from
							</span>
							<span className="block break-words text-sm text-nova-text">
								{summary.label}
							</span>
							{summary.detail !== undefined ? (
								<span
									className={`block break-words text-xs ${summary.needsAttention ? "text-nova-rose" : "text-nova-text-muted"}`}
								>
									{summary.detail}
								</span>
							) : null}
						</span>
						<Icon
							icon={tablerChevronDown}
							className="size-4 shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-180"
						/>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						<RelationPathBuilder
							value={relation}
							onChange={(next) =>
								onChange(prop(value.caseType, value.property, next))
							}
							invalid={invalid}
							allowSelf
							admitChange={(next) =>
								admitChange?.(prop(value.caseType, value.property, next)) ?? {
									admitted: true,
								}
							}
						/>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

interface RelationSummary {
	readonly label: string;
	readonly detail?: string;
	readonly needsAttention?: boolean;
}

type SummaryCaseType = {
	readonly name: string;
	readonly parent_type?: string;
};

function destinationLabel(
	prefix: string,
	destination: string | undefined,
): string {
	return destination === undefined
		? prefix
		: `${prefix}: ${humanizeId(destination)}`;
}

function savedRelationshipDetail(identifier: string): string {
	const relationship = humanizeId(identifier);
	return relationship.length === 0
		? "Saved connection needs attention"
		: `Saved connection needs attention: ${relationship}`;
}

/**
 * Summarize a relational read in the author's vocabulary. Direction and the
 * case reached are the ordinary decision; the storage-level relationship name
 * stays in More settings unless it is needed to understand or repair an
 * ambiguous/imported path.
 */
function relationSummary(
	value: NonNullable<PropertyRef["via"]>,
	originCaseType: string,
	caseTypes: readonly SummaryCaseType[],
): RelationSummary {
	const destination = resolveRelationDestination(
		value,
		originCaseType,
		caseTypes,
	);

	switch (value.kind) {
		case "self":
			return { label: "This case" };
		case "ancestor": {
			const invalidStep = value.via.find(
				(step) => !XML_ELEMENT_NAME_PATTERN.test(step.identifier),
			);
			if (invalidStep !== undefined) {
				return {
					label: destinationLabel(
						value.via.length === 1 ? "Parent case" : "Ancestor case",
						destination,
					),
					detail: savedRelationshipDetail(invalidStep.identifier),
					needsAttention: true,
				};
			}
			return {
				label: destinationLabel(
					value.via.length === 1 ? "Parent case" : "Ancestor case",
					destination,
				),
				detail:
					value.via.length > 1
						? `${value.via.length} connections away`
						: undefined,
			};
		}
		case "subcase":
		case "any-relation": {
			const selectedCaseType = destination;
			const prefix = value.kind === "subcase" ? "Child case" : "Related case";
			const invalidIdentifier = !XML_ELEMENT_NAME_PATTERN.test(
				value.identifier,
			);
			if (invalidIdentifier) {
				return {
					label: destinationLabel(prefix, selectedCaseType),
					detail: savedRelationshipDetail(value.identifier),
					needsAttention: true,
				};
			}

			const needsCaseType = selectedCaseType === undefined;
			if (needsCaseType) {
				const unavailable =
					value.ofCaseType !== undefined
						? `${humanizeId(value.ofCaseType)} is unavailable`
						: value.kind === "subcase"
							? "Choose a child case type"
							: "Choose a related case type";
				return {
					label: prefix,
					detail: `${unavailable} · Saved connection: ${humanizeId(value.identifier)}`,
					needsAttention: true,
				};
			}

			return { label: destinationLabel(prefix, selectedCaseType) };
		}
	}
}
