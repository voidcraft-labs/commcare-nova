// components/builder/case-list-config/ColumnEditor.tsx
//
// Inspector body for one `Column`. The rail owns the field's data source and
// formatting — the properties that cannot be manipulated in the running-app
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
	CONSOLE_MENU_ITEM_MIN,
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
import type { CaseType, Column, ColumnKind } from "@/lib/domain";
import {
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { propertyDisplayLabel } from "../shared/primitives/propertyDisplay";
import {
	type ColumnCardSchema,
	type ColumnEditContext,
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
 * downstream — this one only governs the column-card pickers.
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
	 * doesn't take a relation walk — properties resolve against
	 * the originating scope only.
	 */
	readonly currentCaseType: string;
	/**
	 * Surfaces the boolean validity verdict to the parent on
	 * every onChange. The parent gates its save affordance on
	 * this. The editor does not gate the onChange itself —
	 * invalid edits flow through so the user can keep authoring.
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
	onValidityChange,
}: ColumnEditorProps) {
	const ctx = useMemo<ColumnEditContext>(
		() => ({ caseTypes, currentCaseType }),
		[caseTypes, currentCaseType],
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
				? propertyDisplayLabel(property)
				: "This information";
		const guidance =
			value.kind === "phone"
				? "Choose information saved as text or a choice."
				: "Choose information saved as a date or date and time.";
		return [
			`${information} can’t use ${schema.label.toLowerCase()} formatting. ${guidance}`,
		] as const;
	}, [ctx, value]);

	// Standardized parent-validity propagation — fires on mount + on
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
 * Map a kind to the field-and-header-preserving rebuild for the
 * target kind. The five non-calc kinds carry `field: string`, so a
 * kind swap among them ALWAYS preserves the field verbatim — non-
 * twin transitions reset the kind-specific extras (date pattern,
 * threshold, mapping table) to the target schema's defaults.
 *
 * Calculated columns have no `field`. Swapping FROM calc into a
 * field-bearing kind seeds the new column's field via the target
 * schema's default-value factory; swapping TO calc drops the
 * field entirely. Header is preserved on every transition. The
 * column's `uuid` and optional common slots (`sort`, visibility,
 * and each surface order) thread through verbatim —
 * they're identity / surface-visibility shape, not kind-specific.
 *
 * Exported as part of the module's tested surface — the
 * transformation is the contract (the emitted Column shape), so the
 * unit tests call it directly rather than driving the menu chrome.
 */
export function preservedColumnSwap(
	currentValue: Column,
	targetKind: ColumnKind,
	ctx: ColumnEditContext,
): Column {
	const { uuid, header } = currentValue;
	const slots = {
		sort: currentValue.sort,
		visibleInList: currentValue.visibleInList,
		visibleInDetail: currentValue.visibleInDetail,
		listOrder: currentValue.listOrder,
		detailOrder: currentValue.detailOrder,
	};
	// Field source: the current value's field if the source has one;
	// otherwise the target schema's default-picked field.
	const sourceField = "field" in currentValue ? currentValue.field : "";

	switch (targetKind) {
		case "plain":
			return plainColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "plain"),
				header,
				slots,
			);
		case "phone":
			return phoneColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "phone"),
				header,
				slots,
			);
		case "date": {
			// Twin: source is already a date column → preserve the
			// pattern verbatim. Otherwise fall back to the target
			// schema's default pattern.
			const seed = columnCardSchemas.date.defaultValue(ctx);
			const pattern =
				currentValue.kind === "date" ? currentValue.pattern : seed.pattern;
			return dateColumn(
				uuid,
				sourceField || seed.field,
				header,
				pattern,
				slots,
			);
		}
		case "id-mapping": {
			// Twin: source is already id-mapping → preserve the table.
			const mapping =
				currentValue.kind === "id-mapping" ? currentValue.mapping : [];
			return idMappingColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "id-mapping"),
				header,
				mapping,
				slots,
			);
		}
		case "image-map": {
			// Twin: source is already image-map → preserve the value→image
			// table. id-mapping's table has incompatible entry shape
			// ({value,label} vs {value,assetId}), so a cross-kind swap
			// starts empty rather than mis-mapping labels onto images.
			const mapping =
				currentValue.kind === "image-map" ? currentValue.mapping : [];
			return imageMapColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "image-map"),
				header,
				mapping,
				slots,
			);
		}
		case "interval": {
			// Twin: source is already interval → preserve every
			// kind-specific extra (threshold, unit, display, text).
			// Non-twin sources seed the extras from the target schema's
			// default factory.
			const seed = columnCardSchemas.interval.defaultValue(ctx);
			if (currentValue.kind === "interval") {
				return intervalColumn(
					uuid,
					currentValue.field,
					header,
					currentValue.threshold,
					currentValue.unit,
					currentValue.display,
					currentValue.text,
					slots,
				);
			}
			return intervalColumn(
				uuid,
				sourceField || seed.field,
				header,
				seed.threshold,
				seed.unit,
				seed.display,
				seed.text,
				slots,
			);
		}
		case "calculated": {
			// Twin: source is already calculated → preserve the
			// expression verbatim. Non-twin sources seed an empty-
			// string literal expression — the same shape the schema's
			// `defaultValue` factory uses, kept inline here so a kind
			// swap doesn't pull a fresh uuid via the factory.
			const expression =
				currentValue.kind === "calculated"
					? currentValue.expression
					: term(literal(""));
			return calculatedColumn(uuid, header, expression, slots);
		}
	}
}

/** Pick the target schema's default field for a non-calc kind. The
 *  default factory mints a uuid we don't want here (the kind swap
 *  preserves the source's uuid), so the helper invokes the factory
 *  and discards everything but the field. */
function pickFieldFromTarget(
	ctx: ColumnEditContext,
	target: Exclude<ColumnKind, "calculated">,
): string {
	const seed = columnCardSchemas[target].defaultValue(ctx);
	return seed.field;
}

/**
 * Full-width "Display as" picker — swaps the column's kind while
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

	const nextFor = (targetKind: ColumnKind): Column => {
		const draft = draftsByKindRef.current.get(targetKind);
		if (draft === undefined) {
			return preservedColumnSwap(currentValue, targetKind, ctx);
		}
		return restoreColumnDraft(draft, currentValue);
	};
	const replaceWith = <K extends ColumnKind>(schema: ColumnCardSchema<K>) => {
		const consequence = columnKindChangeConsequence(
			currentValue,
			schema.kind,
			ctx,
		);
		if (consequence !== null) {
			setPendingKind(schema.kind);
			return;
		}
		onChange(nextFor(schema.kind));
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
						// Calculated source has no property; every target kind
						// stays at full opacity. Otherwise consult the
						// per-target schema's applicability predicate against
						// the current property.
						const isApplicable =
							currentValue.kind === "calculated"
								? true
								: s.applicableForProperty(property);
						return (
							<DropdownMenuItem
								key={s.kind}
								onClick={() => replaceWith(s)}
								disabled={isCurrent || !isApplicable}
								className={`${CONSOLE_MENU_ITEM_MIN} ${
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
						<AlertDialogTitle className="font-display">
							Change display to {pendingSchema?.label ?? "another style"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingConsequence ?? "This replaces the current display setup"}.
							Saved case information won’t change.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingKind === null) return;
								onChange(nextFor(pendingKind));
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

/** Common slots follow the active display while a locally retained kind draft
 * restores only that kind's source and formatting. */
function restoreColumnDraft(draft: Column, current: Column): Column {
	return {
		...draft,
		uuid: current.uuid,
		header: current.header,
		sort: current.sort,
		visibleInList: current.visibleInList,
		visibleInDetail: current.visibleInDetail,
		listOrder: current.listOrder,
		detailOrder: current.detailOrder,
	} as Column;
}

/** Explain only changes that discard meaningful authored work. Ordinary
 * presentation changes stay one click; custom mappings, calculations, and
 * tuned formats receive a truthful consequence before replacement. */
function columnKindChangeConsequence(
	current: Column,
	targetKind: ColumnKind,
	ctx: ColumnEditContext,
): string | null {
	if (current.kind === targetKind) return null;
	if (targetKind === "calculated" && current.kind !== "calculated") {
		return "The current information source will be replaced with a new calculation";
	}
	switch (current.kind) {
		case "plain":
		case "phone":
			return null;
		case "date": {
			const seed = columnCardSchemas.date.defaultValue(ctx);
			return current.pattern === seed.pattern
				? null
				: "The custom date format will be removed";
		}
		case "id-mapping":
			return current.mapping.length === 0
				? null
				: "The friendly value labels will be removed";
		case "image-map":
			return current.mapping.length === 0
				? null
				: "The value images will be removed";
		case "interval": {
			const seed = columnCardSchemas.interval.defaultValue(ctx);
			const customized =
				current.threshold !== seed.threshold ||
				current.unit !== seed.unit ||
				current.display !== seed.display ||
				current.text !== seed.text;
			return customized ? "The time range settings will be removed" : null;
		}
		case "calculated": {
			const seed = columnCardSchemas.calculated.defaultValue(ctx);
			return JSON.stringify(current.expression) ===
				JSON.stringify(seed.expression)
				? null
				: "The calculation will be replaced with saved case information";
		}
	}
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
