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
import { canonicalCasePropertyName, effectiveDataType } from "@/lib/domain";
import {
	acceptsType,
	compatibleTypesFor,
	inSubjectConstraint,
	inValueConstraint,
	isIn,
	type Literal,
	literal,
	literalType,
	type Predicate,
	prop,
	type ResolvedType,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	useResolvedType,
} from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { removeAndRestoreFocus } from "../focusAfterRemoval";
import { appendSlot, appendSlotIndex, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { LiteralValueInput } from "../primitives/LiteralValueInput";
import { useStableListIdentity } from "../useStableListIdentity";
import { PredicateVerbMenu } from "./PredicateVerbMenu";
import {
	reseedLiteralForConstraint,
	resolveExpressionType,
	seedLiteralForProperty,
} from "./reseed";

export function inDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "in" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const subjectConstraint = inSubjectConstraint();
	const property = ct?.properties.find((candidate) =>
		acceptsType(subjectConstraint, effectiveDataType(candidate)),
	);
	const propName = canonicalCasePropertyName(property?.name ?? "");
	// Seed the value of the property's OWN type — a text `literal("")`
	// opposite a non-text first property would be a soundness error.
	return isIn(
		prop(ctx.currentCaseType, propName),
		seedLiteralForProperty(property),
	);
}

interface InCardProps {
	readonly value: Extract<Predicate, { kind: "in" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function InCard({ value, onChange, path }: InCardProps) {
	const ctx = usePredicateEditContext();
	const rowIdentity = useStableListIdentity(value.values);

	// Anchor property name for typed-input switching in each value
	// row. Pulled from the LEFT-slot AST shape; only meaningful
	// when the left is a property reference.
	const propertyName =
		value.left.kind === "term" && value.left.term.kind === "prop"
			? value.left.term.property
			: undefined;

	// The subject (left) drives each membership value — the value
	// widgets are typed against the `in` value constraint (compatible
	// with the subject), and a change of subject reseeds any
	// now-incompatible value in the same onChange. `inValueConstraint`
	// always yields a concrete accept-set (`compatibleTypesFor` never
	// returns "any"); narrow for the Set-typed widget prop.
	const subjectType = useResolvedType(value.left);
	const valueConstraint = inValueConstraint(subjectType);
	const valueAccepts =
		valueConstraint.accepts === "any" ? undefined : valueConstraint.accepts;

	const setLeft = (left: ValueExpression) => {
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
		const seed = reseedLiteralForConstraint(
			literal(""),
			compatibleTypesFor(subjectType),
		);
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
						caseTypeName={ctx.currentCaseType}
						propertyName={propertyName}
						accepts={valueAccepts}
						indexPath={appendSlotIndex(path, "values", i)}
					/>
				))}
				<Button
					type="button"
					variant="outline"
					size="xl"
					onClick={append}
					data-removal-focus-fallback
					className="w-full border-dashed border-white/[0.10] bg-transparent px-3 text-sm text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-transparent not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-transparent"
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
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly onRemove: () => void;
	readonly isOnlyOne: boolean;
	readonly caseTypeName: string;
	readonly propertyName: string | undefined;
	readonly accepts: ReadonlySet<ResolvedType> | undefined;
	readonly indexPath: EditorPath;
}) {
	const errors = useEditorErrorsAt(indexPath);
	return (
		<div className="space-y-0.5" data-removal-focus-row>
			<div className="flex items-start gap-1.5">
				<div className="flex-1">
					<LiteralValueInput
						value={value}
						onChange={onChange}
						caseTypeName={caseTypeName}
						propertyName={propertyName}
						accepts={accepts}
						invalid={errors.length > 0}
					/>
				</div>
				{!isOnlyOne && (
					<SimpleTooltip content="Remove this value">
						<Button
							type="button"
							variant="ghost"
							size="icon-lg"
							aria-label="Remove value"
							onClick={(event) =>
								removeAndRestoreFocus(event.currentTarget, onRemove)
							}
							data-removal-action
							className="size-11 rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-rose dark:not-disabled:hover:bg-white/[0.05]"
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
