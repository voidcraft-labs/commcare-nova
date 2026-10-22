// components/builder/shared/cards/InCard.tsx
//
// Renders the `in` predicate. Property picker on the left + a
// literal-list editor (one row per literal, typed by the property's
// data type). The schema requires at least one value; the card
// suppresses the "remove" affordance on the last remaining row.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { effectiveDataType } from "@/lib/domain";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	acceptsType,
	compatibleTypesFor,
	type Expression,
	inSubjectConstraint,
	inValueConstraint,
	isIn,
	type Literal,
	literal,
	literalType,
	prop,
	type ScalarType,
	sessionContext,
	tableColumn,
} from "@/lib/domain/expression";
import { CaseTypeValuePicker } from "../CaseTypeValuePicker";
import {
	caseTypeValueGroups,
	defaultCaseTypeValue,
} from "../caseTypeValueModel";
import { comparesCaseType, possibleRowCaseTypes } from "../comparisonModel";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	useResolvedType,
} from "../editorContext";
import {
	caseDataInScope,
	type PredicateEditContext,
	tableRowInScope,
} from "../editorSchemas";
import { removeAndRestoreFocus } from "../focusAfterRemoval";
import { membershipLiteralContext } from "../membershipLiteralContext";
import { appendSlot, appendSlotIndex, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { LiteralValueInput } from "../primitives/LiteralValueInput";
import { isLiteralList } from "../recordCardShape";
import { useStableListIdentity } from "../useStableListIdentity";
import { PredicateVerbMenu } from "./PredicateVerbMenu";
import {
	reseedLiteralForConstraint,
	resolveExpressionType,
	seedLiteralForProperty,
} from "./reseed";

export function inDefault(ctx: PredicateEditContext): ExpressionOfKind<"in"> {
	const subjectConstraint = inSubjectConstraint();
	if (tableRowInScope(ctx)) {
		const column = ctx.tableScope?.columns.find((candidate) =>
			acceptsType(subjectConstraint, candidate.dataType),
		);
		if (ctx.tableScope === undefined || column === undefined) {
			throw new Error(
				"A table-row membership condition requires one admitted active-table column.",
			);
		}
		return isIn(
			tableColumn(ctx.tableScope.tableId, column.id),
			reseedLiteralForConstraint(
				literal(""),
				compatibleTypesFor(column.dataType),
			),
		);
	}
	// A global slot has no case to read; membership on a session value
	// (text) is the meaningful shape there.
	if (!caseDataInScope(ctx)) {
		return isIn(sessionContext("username"), literal(""));
	}
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((candidate) =>
		acceptsType(subjectConstraint, effectiveDataType(candidate)),
	);
	const propName = property?.name ?? "";
	// Seed the value of the property's OWN type: a text `literal("")`
	// opposite a non-text first property would be a soundness error.
	return isIn(
		prop(ctx.currentCaseType, propName),
		seedLiteralForProperty(property),
	);
}

interface InCardProps {
	readonly value: ExpressionOfKind<"in">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function InCard(props: InCardProps) {
	if (!isLiteralList(props.value.values))
		return (
			<p role="status">This saved expression cannot be edited here yet.</p>
		);
	return (
		<EditableInCard
			{...props}
			value={{ ...props.value, values: props.value.values }}
		/>
	);
}

function EditableInCard({
	value,
	onChange,
	path,
}: Omit<InCardProps, "value"> & {
	readonly value: Omit<InCardProps["value"], "values"> & {
		readonly values: [Literal, ...Literal[]];
	};
}) {
	const ctx = usePredicateEditContext();
	const rowIdentity = useStableListIdentity(value.values);

	const { propertyName, caseTypeName } = membershipLiteralContext(
		value,
		ctx.currentCaseType,
		ctx.caseTypes,
	);

	// The subject (left) drives each membership value: the value
	// widgets are typed against the `in` value constraint (compatible
	// with the subject), and a change of subject reseeds any
	// now-incompatible value in the same onChange. `inValueConstraint`
	// always yields a concrete accept-set (`compatibleTypesFor` never
	// returns "any"); narrow for the Set-typed widget prop.
	const subjectType = useResolvedType(value.left);
	const valueConstraint = inValueConstraint(subjectType);
	const valueAccepts =
		valueConstraint.accepts === "any" ? undefined : valueConstraint.accepts;

	// "Case type" is compared with case types of the app, kept as literals
	// (decision D5), each one a name of the catalog.
	const caseTypeNames = ctx.caseTypes.map((type) => type.name);
	const comparesType = comparesCaseType(value.left);
	const caseTypeSeed = (taken: readonly Literal[]): Literal | undefined => {
		const used = new Set(taken.map((item) => item.value));
		const groups = caseTypeValueGroups(
			caseTypeNames,
			possibleRowCaseTypes(ctx),
		);
		const name =
			[...groups.likely, ...groups.others].find((n) => !used.has(n)) ??
			defaultCaseTypeValue(caseTypeNames, possibleRowCaseTypes(ctx));
		return name === undefined ? undefined : literal(name);
	};

	const setLeft = (left: Expression) => {
		if (comparesCaseType(left)) {
			const seed = caseTypeSeed([]);
			const names = new Set(caseTypeNames);
			const reseeded = value.values.map((item) =>
				typeof item.value === "string" && names.has(item.value)
					? item
					: (seed ?? item),
			);
			const [first, ...rest] = reseeded;
			rowIdentity.stage(reseeded, { kind: "replace" });
			onChange(isIn(left, first, ...rest));
			return;
		}
		const accepts = compatibleTypesFor(resolveExpressionType(left, ctx));
		const reseeded = value.values.map((item) =>
			accepts.has(literalType(item))
				? item
				: reseedLiteralForConstraint(item, accepts),
		);
		const [first, ...rest] = reseeded;
		rowIdentity.stage(reseeded, { kind: "replace" });
		onChange(isIn(left, first, ...rest));
	};

	const setValueAt = (index: number, next: Literal) => {
		const updated = value.values.map((item, itemIndex) =>
			itemIndex === index ? next : item,
		);
		const [first, ...rest] = updated;
		rowIdentity.stage(updated, { kind: "replace" });
		onChange(isIn(value.left, first, ...rest));
	};

	const removeAt = (index: number) => {
		// Schema requires non-empty; refuse the last row's removal.
		if (value.values.length === 1) return;
		const filtered = value.values.filter((_, i) => i !== index);
		const [first, ...rest] = filtered;
		rowIdentity.stage(filtered, {
			kind: "splice",
			index,
			deleteCount: 1,
			insertCount: 0,
		});
		onChange(isIn(value.left, first, ...rest));
	};

	const append = () => {
		// Seed the new value of the subject's type so the appended row
		// lands type-correct (an int `in` can't add a text `literal("")`).
		const seed =
			(comparesType ? caseTypeSeed(value.values) : undefined) ??
			reseedLiteralForConstraint(literal(""), compatibleTypesFor(subjectType));
		const [first, ...rest] = value.values;
		const next = [...value.values, seed];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.values.length,
			deleteCount: 0,
			insertCount: 1,
		});
		onChange(isIn(value.left, first, ...rest, seed));
	};

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<ExpressionPicker
					value={value.left}
					onChange={setLeft}
					path={appendSlot(path, "left")}
					constraint={inSubjectConstraint()}
					presentation="subject"
					variant="nested"
					admitReplacement={(left) => {
						if (!comparesCaseType(left))
							return (
								ctx.admitExpressionChange?.(appendSlot(path, "left"), left) ?? {
									admitted: true,
								}
							);
						const seed = caseTypeSeed([]);
						return seed === undefined
							? {
									admitted: false,
									reason: "Add a case type to the app first",
								}
							: (ctx.admitExpressionChange?.(path, isIn(left, seed)) ?? {
									admitted: true,
								});
					}}
				/>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div className="space-y-1.5">
				{value.values.map((v, i) => (
					<ValueRow
						key={rowIdentity.keys[i]}
						value={v}
						onChange={(next) => setValueAt(i, next)}
						onRemove={() => removeAt(i)}
						isOnlyOne={value.values.length === 1}
						caseTypeName={caseTypeName}
						propertyName={propertyName}
						accepts={valueAccepts}
						indexPath={appendSlotIndex(path, "values", i)}
						caseTypeValues={
							comparesType
								? {
										caseTypes: caseTypeNames,
										possible: possibleRowCaseTypes(ctx),
									}
								: undefined
						}
					/>
				))}
				<Button
					type="button"
					variant="ghost"
					onClick={append}
					data-removal-focus-fallback
					className="nova-add-slot w-full"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span>Add value</span>
				</Button>
			</div>
		</div>
	);
}

function ValueRow({
	value,
	onChange,
	onRemove,
	isOnlyOne,
	caseTypeName,
	propertyName,
	accepts,
	indexPath,
	caseTypeValues,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly onRemove: () => void;
	readonly isOnlyOne: boolean;
	readonly caseTypeName: string;
	readonly propertyName: string | undefined;
	readonly accepts: ReadonlySet<ScalarType> | undefined;
	readonly indexPath: EditorPath;
	readonly caseTypeValues?: {
		readonly caseTypes: readonly string[];
		readonly possible: readonly string[];
	};
}) {
	const errors = useEditorErrorsAt(indexPath);
	return (
		<div className="space-y-0.5" data-removal-focus-row>
			<div className="flex items-start gap-1.5">
				<div className="flex-1">
					{caseTypeValues === undefined ? (
						<LiteralValueInput
							value={value}
							onChange={onChange}
							caseTypeName={caseTypeName}
							propertyName={propertyName}
							accepts={accepts}
							invalid={errors.length > 0}
						/>
					) : (
						<CaseTypeValuePicker
							value={typeof value.value === "string" ? value.value : undefined}
							onChange={(name) => onChange(literal(name))}
							caseTypes={caseTypeValues.caseTypes}
							possible={caseTypeValues.possible}
							invalid={errors.length > 0}
						/>
					)}
				</div>
				{!isOnlyOne && (
					<SimpleTooltip content="Remove this value">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label="Remove value"
							onClick={(event) =>
								removeAndRestoreFocus(event.currentTarget, onRemove)
							}
							data-removal-action
							className="rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-rose dark:not-disabled:hover:bg-white/[0.05]"
						>
							<Icon icon={tablerX} width="13" height="13" />
						</Button>
					</SimpleTooltip>
				)}
			</div>
			<InlineError errors={errors} />
		</div>
	);
}
