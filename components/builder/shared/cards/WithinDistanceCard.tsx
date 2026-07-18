// components/builder/shared/cards/WithinDistanceCard.tsx
//
// Renders the `within-distance` predicate. Property picker
// (geopoint-typed only) + center-coordinate input (a Term-shaped
// ValueExpression — typed-text via the picker) + numeric distance
// + unit menu (miles / kilometers).

"use client";
import { useEffect, useId, useRef, useState } from "react";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { canonicalCasePropertyName } from "@/lib/domain";
import {
	DISTANCE_UNITS,
	type DistanceUnit,
	distanceValidationIssue,
	literal,
	type Predicate,
	type PropertyRef,
	prop,
	within,
	withinCenterConstraint,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

const UNIT_LABELS: Record<DistanceUnit, string> = {
	miles: "miles",
	kilometers: "kilometers",
};

/** Module-level filter so render-time identity stays stable —
 *  `PropertyPicker`'s `useMemo` on `[caseType, filter]` invalidates
 *  on each fresh-arrow filter, even when the actual selection rule
 *  is constant. */
const GEOPOINT_PROPERTY_FILTER = (p: { data_type?: string }): boolean =>
	p.data_type === "geopoint";

/** The center resolves to a geopoint or a text-encoded coordinate —
 *  module-const for a stable identity across renders. */
const CENTER_CONSTRAINT = withinCenterConstraint();

export function withinDistanceDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "within-distance" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) => p.data_type === "geopoint");
	const propName = canonicalCasePropertyName(property?.name ?? "");
	return within(prop(ctx.currentCaseType, propName), literal(""), 1, "miles");
}

interface WithinDistanceCardProps {
	readonly value: Extract<Predicate, { kind: "within-distance" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function WithinDistanceCard({
	value,
	onChange,
	path,
}: WithinDistanceCardProps) {
	// Center errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path — rendering them
	// here too would double the diagnostic row count.
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));

	const setProperty = (next: PropertyRef) => {
		onChange(within(next, value.center, value.distance, value.unit));
	};

	const setCenter = (next: Parameters<typeof within>[1]) => {
		onChange(within(value.property, next, value.distance, value.unit));
	};

	const setDistance = (next: number) => {
		onChange(within(value.property, value.center, next, value.unit));
	};

	const setUnit = (unit: DistanceUnit) => {
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

			<div className="grid grid-cols-1 @md:grid-cols-[1.6fr_auto_auto] gap-2 items-start">
				<div>
					<div className="mb-1 text-[13px] font-medium text-nova-text-secondary">
						Center
					</div>
					{/* Center coordinate routes through `ExpressionPicker`.
					 *  CCHQ accepts a typed-geopoint search input as the
					 *  natural shape AND a wire-form coordinate string
					 *  (per `query_functions.py::within_distance` —
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
				<div>
					<div className="mb-1 text-[13px] font-medium text-nova-text-secondary">
						Distance
					</div>
					<DistanceInput
						value={value.distance}
						unit={value.unit}
						onChange={setDistance}
					/>
				</div>
				<div>
					<div className="mb-1 text-[13px] font-medium text-nova-text-secondary">
						Unit
					</div>
					<UnitMenu
						unit={value.unit}
						distance={value.distance}
						setUnit={setUnit}
					/>
				</div>
			</div>
		</div>
	);
}

function DistanceInput({
	value,
	unit,
	onChange,
}: {
	readonly value: number;
	readonly unit: DistanceUnit;
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
				className={`h-auto min-h-11 w-full border bg-nova-deep/50 px-3 text-sm text-nova-text focus-visible:ring-1 md:text-sm dark:bg-nova-deep/50 ${
					error !== undefined
						? "border-nova-rose/40 focus-visible:border-nova-rose/60 focus-visible:ring-nova-rose/30"
						: "border-white/[0.06] focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30"
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

function positiveDistance(
	draft: string,
	unit: DistanceUnit,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
	if (draft.trim() === "") {
		return { error: "Enter a distance greater than 0" };
	}
	const parsed = Number(draft);
	const issue = distanceValidationIssue(parsed, unit);
	switch (issue) {
		case "not-positive-finite":
			return { error: "Enter a distance greater than 0" };
		case "meters-overflow":
			return { error: `Enter a smaller distance in ${UNIT_LABELS[unit]}` };
		case undefined:
			return { value: parsed };
		default: {
			const _exhaustive: never = issue;
			return _exhaustive;
		}
	}
}

function UnitMenu({
	unit,
	distance,
	setUnit,
}: {
	readonly unit: DistanceUnit;
	readonly distance: number;
	readonly setUnit: (unit: DistanceUnit) => void;
}) {
	const errorId = useId();
	const [errorState, setErrorState] = useState<{
		readonly distance: number;
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
					if (next !== "miles" && next !== "kilometers") return;
					if (distanceValidationIssue(distance, next) === "meters-overflow") {
						setErrorState({
							distance,
							unit,
							message: `Enter a smaller distance before switching to ${UNIT_LABELS[next]}`,
						});
						return;
					}
					setErrorState(undefined);
					setUnit(next);
				}}
			>
				<SelectTrigger
					aria-label={`Distance unit ${UNIT_LABELS[unit]}`}
					aria-invalid={error !== undefined || undefined}
					aria-describedby={error === undefined ? undefined : errorId}
					className={`h-auto min-h-11 bg-nova-deep/50 px-3 text-sm text-nova-violet-bright dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50 ${
						error === undefined
							? "border-white/[0.06] not-disabled:hover:border-nova-violet/30"
							: "border-nova-rose/40 focus-visible:border-nova-rose/60 focus-visible:ring-nova-rose/30"
					}`}
				>
					<SelectValue>{UNIT_LABELS[unit]}</SelectValue>
				</SelectTrigger>
				<SelectContent align="end">
					{DISTANCE_UNITS.map((nextUnit) => (
						<SelectItem key={nextUnit} value={nextUnit} className="min-h-11">
							{UNIT_LABELS[nextUnit]}
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
