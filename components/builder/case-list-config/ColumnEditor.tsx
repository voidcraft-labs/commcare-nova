// components/builder/case-list-config/ColumnEditor.tsx
//
// Inspector body for one `Column`. The rail owns the field's data source and
// formatting: the properties that cannot be manipulated in the running-app
// composition. Results/Details membership and order, and the list's default
// ordering, each live once in the center canvas where their effect is visible.
//
// Every control carries a visible text label and a full-size target.
// The kind-vs-property applicability check surfaces inline next to
// the field picker AND propagates to the parent's `onValidityChange`
// so the surrounding save affordance can gate.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	CONSOLE_MENU_ITEM_CLS,
	CONSOLE_TRIGGER_CLS,
	InspectorSection,
} from "@/components/builder/inspector/inspectorChrome";
import { PredicateEditProvider } from "@/components/builder/shared/editorContext";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { CaseType, Column, ColumnKind, UserProperty } from "@/lib/domain";
import { columnKindPropertyRequirement } from "@/lib/domain";
import { propertyDisplayLabel } from "../shared/primitives/propertyDisplay";
import {
	columnKindChangeConsequence,
	nextColumnDisplay,
} from "./columnDisplayState";
import {
	type ColumnCardSchema,
	type ColumnEditContext,
	canSeedColumnKind,
	columnCardSchemaList,
	columnCardSchemas,
	resolveColumnProperty,
} from "./columnEditorSchemas";
import { NO_SEARCH_INPUTS } from "./searchInputResolution";

/**
 * Module-scoped empty validity-index passed to the predicate
 * provider. The column editor surfaces applicability errors via
 * the `errors` prop on each card (NOT through the
 * `useEditorErrorsAt` lookup the predicate / expression editors
 * use), so the index is unused at this level. Calculated columns'
 * inner `ExpressionCardEditor` builds its own validity index
 * downstream: this one only governs the column-card pickers.
 */
const EMPTY_VALIDITY_INDEX = new Map<string, readonly string[]>();

interface ColumnEditorProps {
	/** Current column AST node. */
	readonly value: Column;
	/** Fired with the next AST whenever the user mutates the
	 *  column. */
	readonly onChange: (next: Column) => void;
	/** Blueprint case-type definitions. Drives the property
	 *  picker's dropdown content. */
	readonly caseTypes: readonly CaseType[];
	/**
	 * The case-type the column reads against. The case list
	 * always reads against the module's case-type, so the editor
	 * doesn't take a relation walk: properties resolve against
	 * the originating scope only.
	 */
	readonly currentCaseType: string;
	readonly userProperties?: readonly UserProperty[];
	/** Whether the module currently emits the Search workflow. */
	readonly searchIsEffective?: boolean;
	/**
	 * Reports whether the supplied field/display pair satisfies the
	 * same admission predicate as the kind and property pickers.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Column inspector body: display kind and the selected kind's own properties.
 */
export function ColumnEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	userProperties = [],
	searchIsEffective = false,
	onValidityChange,
}: ColumnEditorProps) {
	const projectProse = useProseProjection();
	const ctx = useMemo<ColumnEditContext>(
		() => ({ caseTypes, currentCaseType, userProperties, searchIsEffective }),
		[caseTypes, currentCaseType, userProperties, searchIsEffective],
	);

	// Per-kind applicability check. Calculated columns have no
	// `field` slot to validate, so the check is skipped. For every
	// other kind, the schema's `applicableForProperty` predicate
	// against the resolved property is the structural gate;
	// mismatches surface inline next to the field picker.
	const applicabilityErrors = useMemo(() => {
		if (value.kind === "calculated") return [] as const;
		const property = resolveColumnProperty(ctx, value.field);
		const schema = columnCardSchemas[value.kind];
		if (schema.applicableForProperty(property)) return [] as const;
		const information =
			property !== undefined
				? propertyDisplayLabel(property, projectProse)
				: "This information";
		// Keyed off the requirement the schema actually states, not off
		// the kind — a two-way "phone or else a date" fork sent every new
		// text-shaped kind down the date branch and told its author the
		// opposite of what it needs.
		const guidance =
			columnKindPropertyRequirement(value.kind) === "text-shaped"
				? "Choose information saved as text or a choice."
				: "Choose information saved as a date or date and time.";
		return [
			`${information} can't use ${schema.label.toLowerCase()} formatting. ${guidance}`,
		] as const;
	}, [ctx, value, projectProse]);

	// Standardized parent-validity propagation: fires on mount + on
	// every transition. The helper ref-stashes the callback so a
	// fresh-each-render parent identity doesn't trip the effect on
	// non-transitions.
	const isValid = applicabilityErrors.length === 0;
	useValidityPropagator({ isValid, onValidityChange });

	const schema = columnCardSchemas[value.kind];
	// Discriminated-union dispatch: each registry entry's
	// `component` is typed for its specific kind
	// (`Extract<Column, { kind: K }>`); the cast widens to the
	// `Column` union so the per-kind `value` / `onChange` types
	// land at the call site. TypeScript can't narrow per-kind
	// across a union dispatch (no flow-typing through an indexed
	// `record[discriminator]` access), so the same cast pattern
	// applies in `ChildPredicateEditor` and `ExpressionPicker`. The
	// `errors?: readonly string[]` slot is on the registry's
	// component type so a card that forgets to accept it fails to
	// compile rather than silently ignoring the prop.
	const Component = schema.component as React.ComponentType<{
		value: Column;
		onChange: (next: Column) => void;
		ctx: ColumnEditContext;
		errors?: readonly string[];
	}>;

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={NO_SEARCH_INPUTS}
			userProperties={userProperties}
			validityIndex={EMPTY_VALIDITY_INDEX}
		>
			<InspectorSection label="Display as">
				<KindPicker
					key={`kind:${value.uuid}`}
					currentValue={value}
					onChange={onChange}
					ctx={ctx}
				/>
				<Component
					key={`card:${value.uuid}`}
					value={value}
					onChange={onChange}
					ctx={ctx}
					errors={applicabilityErrors}
				/>
			</InspectorSection>
		</PredicateEditProvider>
	);
}

/**
 * Full-width "Display as" picker: swaps the column's kind while
 * preserving the header (every kind shares the slot) and the
 * kind-specific extras across structural-twin transitions (see
 * `preservedColumnSwap`).
 *
 * Kinds the current property can't run (a date format over text information,
 * say) stay visible so authors can understand the available presentation
 * choices, but are disabled with a plain-language reason. A display choice
 * must never look selectable and then bounce back from the document gate.
 */
function KindPicker({
	currentValue,
	onChange,
	ctx,
}: {
	readonly currentValue: Column;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
}) {
	const [pendingKind, setPendingKind] = useState<ColumnKind | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	/* A style experiment should be reversible while this inspector remains
	 * open. The document stores only the active column arm, so retain exact
	 * per-kind drafts locally and merge the current common display slots back
	 * in when an author returns to one. The confirmation below still tells the
	 * truth about the persisted change: leaving the inspector commits only the
	 * active style, while ordinary Undo remains available at document level. */
	const draftsByKindRef = useRef(new Map<ColumnKind, Column>());
	useEffect(() => {
		draftsByKindRef.current.set(currentValue.kind, currentValue);
	}, [currentValue]);
	const property =
		currentValue.kind === "calculated"
			? undefined
			: resolveColumnProperty(ctx, currentValue.field);
	const currentKind = currentValue.kind;
	const currentSchema = columnCardSchemas[currentKind];

	const nextFor = (targetKind: ColumnKind): Column | undefined =>
		nextColumnDisplay(currentValue, targetKind, ctx, draftsByKindRef.current);
	const replaceWith = <K extends ColumnKind>(schema: ColumnCardSchema<K>) => {
		const next = nextFor(schema.kind);
		if (next === undefined) return;
		const consequence = columnKindChangeConsequence(
			currentValue,
			schema.kind,
			ctx,
		);
		if (consequence !== null) {
			setPendingKind(schema.kind);
			return;
		}
		onChange(next);
	};
	const pendingSchema =
		pendingKind === null ? null : columnCardSchemas[pendingKind];
	const pendingConsequence =
		pendingKind === null
			? null
			: columnKindChangeConsequence(currentValue, pendingKind, ctx);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					aria-label={`Display as: ${currentSchema.label}`}
					className={CONSOLE_TRIGGER_CLS}
				>
					<Icon
						icon={currentSchema.icon}
						width="16"
						height="16"
						className="text-nova-violet-bright shrink-0"
					/>
					<span className="flex-1 min-w-0 text-left">
						<span className="block text-nova-text">{currentSchema.label}</span>
						<span className="block whitespace-normal break-words text-[13px] leading-5 text-nova-text-muted">
							{currentSchema.description}
						</span>
					</span>
					<Chevron />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					sideOffset={4}
					preferredMinWidth="19rem"
					className="max-h-[min(22.5rem,var(--available-height))] overflow-y-auto"
				>
					{columnCardSchemaList.map((s) => {
						const isCurrent = s.kind === currentKind;
						const isApplicable =
							currentValue.kind === "calculated"
								? canSeedColumnKind(ctx, s.kind)
								: property !== undefined && s.applicableForProperty(property);
						return (
							<DropdownMenuItem
								key={s.kind}
								onClick={() => replaceWith(s)}
								disabled={isCurrent || !isApplicable}
								className={`${CONSOLE_MENU_ITEM_CLS} ${
									isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : ""
								}`}
							>
								<Icon
									icon={s.icon}
									width="15"
									height="15"
									className={
										isCurrent
											? "text-nova-violet-bright"
											: "text-nova-text-muted"
									}
								/>
								<span className="flex-1 text-left min-w-0">
									<div className="whitespace-normal break-words">{s.label}</div>
									<div
										className={`whitespace-normal break-words text-[13px] leading-5 ${
											isCurrent
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}`}
									>
										{isApplicable
											? s.description
											: `Choose ${s.applicabilityRequirement ?? "different information"}`}
									</div>
								</span>
								{isCurrent && (
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="text-nova-violet-bright"
									/>
								)}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>

			<AlertDialog
				open={pendingSchema !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingKind(null);
				}}
			>
				<AlertDialogContent finalFocus={triggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display tracking-tighter">
							Change display to {pendingSchema?.label ?? "another style"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingConsequence ?? "This replaces the current display setup"}.
							Saved case information won't change.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingKind === null) return;
								const next = nextFor(pendingKind);
								if (next === undefined) return;
								onChange(next);
								setPendingKind(null);
							}}
						>
							Change display
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function Chevron() {
	return (
		<Icon
			icon={tablerChevronDown}
			aria-hidden="true"
			width="14"
			height="14"
			className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
		/>
	);
}
