// components/builder/shared/cards/WithinDistanceCard.tsx
//
// Renders the `within-distance` predicate. Property picker
// (geopoint-typed only) + center-coordinate input (a Term-shaped
// Expression: typed-text via the picker) + the distance and its unit.
// The distance is a fixed positive number or a value worked out when the
// search runs (a number); the unit is one of HQ's nine or a value naming
// one (text or a single choice), part 06 §3.8. Each offers "Use a value"
// and the way back to a fixed one, gated by the whole-rule verdict.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerPencil from "@iconify-icons/tabler/pencil";
import tablerVariable from "@iconify-icons/tabler/variable";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	type DistanceUnit,
	distanceValidationIssue,
	type Expression,
	literal,
	type PropertyRef,
	prop,
	within,
	withinCenterConstraint,
} from "@/lib/domain/expression";
import {
	DISTANCE_UNIT_CHOICES,
	DISTANCE_UNIT_LABELS,
	DISTANCE_UNIT_VALUE_CONSTRAINT,
	DISTANCE_VALUE_CONSTRAINT,
	type DistanceSourceChoice,
	distanceSourceChoices,
	isDistanceUnit,
	positiveDistance,
} from "../distanceDraft";
import {
	type ExpressionChangeAdmission,
	useEditorErrorsAt,
	usePredicateEditContext,
} from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

/** Module-level filter so render-time identity stays stable:
 *  `PropertyPicker`'s `useMemo` on `[caseType, filter]` invalidates
 *  on each fresh-arrow filter, even when the actual selection rule
 *  is constant. */
const GEOPOINT_PROPERTY_FILTER = (p: { data_type?: string }): boolean =>
	p.data_type === "geopoint";

/** The center resolves to a geopoint or a text-encoded coordinate:
 *  module-const for a stable identity across renders. */
const CENTER_CONSTRAINT = withinCenterConstraint();

export function withinDistanceDefault(
	ctx: PredicateEditContext,
): ExpressionOfKind<"within-distance"> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) => p.data_type === "geopoint");
	const propName = property?.name ?? "";
	return within(prop(ctx.currentCaseType, propName), literal(""), 1, "miles");
}

interface WithinDistanceCardProps {
	readonly value: ExpressionOfKind<"within-distance">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function WithinDistanceCard({
	value,
	onChange,
	path,
}: WithinDistanceCardProps) {
	const ctx = usePredicateEditContext();
	// Center errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path: rendering them
	// here too would double the diagnostic row count.
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));
	const fixedUnit = typeof value.unit === "string" ? value.unit : undefined;
	const sources = distanceSourceChoices(
		value,
		ctx.knownInputs,
		ctx.admitExpressionChange === undefined
			? undefined
			: (next) => ctx.admitExpressionChange?.(path, next) ?? { admitted: true },
	);

	const setProperty = (next: PropertyRef) => {
		onChange(within(next, value.center, value.distance, value.unit));
	};

	const setCenter = (next: Parameters<typeof within>[1]) => {
		onChange(within(value.property, next, value.distance, value.unit));
	};

	const setDistance = (next: number | Expression) => {
		onChange(within(value.property, value.center, next, value.unit));
	};

	const setUnit = (unit: DistanceUnit | Expression) => {
		onChange(within(value.property, value.center, value.distance, unit));
	};

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<div>
					<PropertyRefPicker
						mode="property-only"
						value={value.property}
						onChange={setProperty}
						filter={GEOPOINT_PROPERTY_FILTER}
						invalid={propertyErrors.length > 0}
						ariaLabel="Location information"
					/>
					<InlineError errors={propertyErrors} />
				</div>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div>
				<div className="mb-1 text-[13px] font-medium text-nova-text-secondary">
					Center
				</div>
				{/* Center coordinate routes through `ExpressionPicker`.
				 *  CCHQ accepts a typed-geopoint search input as the
				 *  natural shape AND a wire-form coordinate string
				 *  (per `query_functions.py::within_distance`:
				 *  `GeoPoint.from_string` parses the text fallback), so
				 *  `withinCenterConstraint` admits `geopoint` OR `text`
				 *  and the picker offers only kinds / sources that
				 *  produce one. The picker's own `CardShell` footer
				 *  surfaces errors at the slot path. */}
				<ExpressionPicker
					value={value.center}
					onChange={setCenter}
					path={appendSlot(path, "center")}
					constraint={CENTER_CONSTRAINT}
					variant="nested"
				/>
			</div>

			<div className="grid grid-cols-1 @md:grid-cols-2 gap-2 items-start">
				<div className="min-w-0">
					<div className="mb-1 text-[13px] font-medium text-nova-text-secondary">
						Distance
					</div>
					{typeof value.distance === "number" ? (
						<DistanceInput
							value={value.distance}
							unit={fixedUnit}
							onChange={setDistance}
						/>
					) : (
						<ExpressionPicker
							value={value.distance}
							onChange={setDistance}
							path={appendSlot(path, "distance")}
							constraint={DISTANCE_VALUE_CONSTRAINT}
							variant="nested"
						/>
					)}
					<SourceSwitch
						choice={sources.distance}
						label={
							typeof value.distance === "number"
								? "Use a value"
								: "Use a fixed distance"
						}
						toValue={typeof value.distance === "number"}
						onSelect={() => onChange(sources.distance.next)}
					/>
				</div>
				<div className="min-w-0">
					<div className="mb-1 text-[13px] font-medium text-nova-text-secondary">
						Unit
					</div>
					{typeof value.unit === "string" ? (
						<UnitMenu
							unit={value.unit}
							distance={value.distance}
							setUnit={setUnit}
						/>
					) : (
						<ExpressionPicker
							value={value.unit}
							onChange={setUnit}
							path={appendSlot(path, "unit")}
							constraint={DISTANCE_UNIT_VALUE_CONSTRAINT}
							variant="nested"
						/>
					)}
					<SourceSwitch
						choice={sources.unit}
						label={fixedUnit !== undefined ? "Use a value" : "Choose a unit"}
						toValue={fixedUnit !== undefined}
						onSelect={() => onChange(sources.unit.next)}
					/>
				</div>
			</div>
		</div>
	);
}

/** "Use a value" and its way back. Disabled with the gate's reason when the
 * switched predicate would be refused, so a click never commits a shape the
 * gate refuses. */
function SourceSwitch({
	choice,
	label,
	toValue,
	onSelect,
}: {
	readonly choice: DistanceSourceChoice;
	readonly label: string;
	readonly toValue: boolean;
	readonly onSelect: () => void;
}) {
	const reasonId = useId();
	const admission: ExpressionChangeAdmission = choice.admission;
	return (
		<div className="mt-1">
			<Button
				type="button"
				variant="ghost"
				className="nova-add-slot gap-1.5"
				disabled={!admission.admitted}
				aria-describedby={admission.admitted ? undefined : reasonId}
				onClick={onSelect}
			>
				<Icon
					icon={toValue ? tablerVariable : tablerPencil}
					width="13"
					height="13"
				/>
				<span>{label}</span>
			</Button>
			{admission.admitted ? null : (
				<p
					id={reasonId}
					className="mt-0.5 text-[12px] leading-4 text-nova-text-muted"
				>
					{admission.reason}
				</p>
			)}
		</div>
	);
}

function DistanceInput({
	value,
	unit,
	onChange,
}: {
	readonly value: number;
	/** The fixed unit, or undefined when a value supplies it. */
	readonly unit: DistanceUnit | undefined;
	readonly onChange: (next: number) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const errorId = useId();
	const initial = String(value);
	const [draft, setDraft] = useState(initial);
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setError(undefined);
		}
	}, [initial, draft]);
	const commit = () => {
		const result = positiveDistance(draft, unit);
		if (result.error !== undefined) {
			setError(result.error);
			return;
		}
		setError(undefined);
		if (draft === initial) return;
		onChange(result.value);
	};
	return (
		<div className="w-36">
			<Input
				ref={inputRef}
				type="number"
				step="any"
				min={Number.MIN_VALUE}
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (
						error !== undefined &&
						positiveDistance(next, unit).error === undefined
					) {
						setError(undefined);
					}
				}}
				onBlur={commit}
				autoComplete="off"
				data-1p-ignore
				aria-label="Distance"
				aria-invalid={error !== undefined || undefined}
				aria-describedby={error !== undefined ? errorId : undefined}
				className={`nova-focusable h-auto min-h-11 w-full border bg-nova-deep/50 px-3 text-sm text-nova-text md:text-sm dark:bg-nova-deep/50 ${
					error !== undefined
						? "nova-focusable border-nova-rose/40"
						: "nova-focusable border-white/[0.06]"
				}`}
			/>
			{error !== undefined ? (
				<FieldError
					id={errorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					{error}
				</FieldError>
			) : null}
		</div>
	);
}

function UnitMenu({
	unit,
	distance,
	setUnit,
}: {
	readonly unit: DistanceUnit;
	readonly distance: number | Expression;
	readonly setUnit: (unit: DistanceUnit) => void;
}) {
	const errorId = useId();
	const [errorState, setErrorState] = useState<{
		readonly distance: number | Expression;
		readonly unit: DistanceUnit;
		readonly message: string;
	}>();
	const error =
		errorState?.distance === distance && errorState.unit === unit
			? errorState.message
			: undefined;
	return (
		<div>
			<Select
				value={unit}
				onValueChange={(next) => {
					if (!isDistanceUnit(next)) return;
					if (
						typeof distance === "number" &&
						distanceValidationIssue(distance, next) === "meters-overflow"
					) {
						setErrorState({
							distance,
							unit,
							message: `Enter a smaller distance before switching to ${DISTANCE_UNIT_LABELS[next]}`,
						});
						return;
					}
					setErrorState(undefined);
					setUnit(next);
				}}
			>
				<SelectTrigger
					aria-label={`Distance unit ${DISTANCE_UNIT_LABELS[unit]}`}
					aria-invalid={error !== undefined || undefined}
					aria-describedby={error === undefined ? undefined : errorId}
					className={`h-auto min-h-11 bg-nova-deep/50 px-3 text-sm text-nova-violet-bright dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50 ${
						error === undefined
							? "border-white/[0.06] not-disabled:hover:border-nova-violet/30"
							: "nova-focusable border-nova-rose/40"
					}`}
				>
					<SelectValue>{DISTANCE_UNIT_LABELS[unit]}</SelectValue>
				</SelectTrigger>
				<SelectContent align="end">
					{DISTANCE_UNIT_CHOICES.map((nextUnit) => (
						<SelectItem key={nextUnit} value={nextUnit}>
							{DISTANCE_UNIT_LABELS[nextUnit]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{error === undefined ? null : (
				<FieldError
					id={errorId}
					className="mt-2 max-w-44 text-[13px] leading-5 text-nova-rose"
				>
					{error}
				</FieldError>
			)}
		</div>
	);
}
