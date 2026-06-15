// components/builder/shared/cards/WithinDistanceCard.tsx
//
// Renders the `within-distance` predicate. Property picker
// (geopoint-typed only) + center-coordinate input (a Term-shaped
// ValueExpression — typed-text via the picker) + numeric distance
// + unit menu (miles / kilometers).

"use client";
import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, useState } from "react";
import {
	type DistanceUnit,
	literal,
	type Predicate,
	type PropertyRef,
	prop,
	within,
	withinCenterConstraint,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

const UNIT_LABELS: Record<DistanceUnit, string> = {
	miles: "miles",
	kilometers: "km",
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
	const propName = property?.name ?? "";
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
						ariaLabel="Geopoint property"
					/>
					<InlineError errors={propertyErrors} />
				</div>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div className="grid grid-cols-1 @md:grid-cols-[1.6fr_auto_auto] gap-2 items-start">
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
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
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Distance
					</div>
					<DistanceInput value={value.distance} onChange={setDistance} />
				</div>
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Unit
					</div>
					<UnitMenu unit={value.unit} setUnit={setUnit} />
				</div>
			</div>
		</div>
	);
}

function DistanceInput({
	value,
	onChange,
}: {
	readonly value: number;
	readonly onChange: (next: number) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const initial = String(value);
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	const commit = () => {
		const parsed = Number.parseFloat(draft);
		if (Number.isFinite(parsed) && parsed >= 0) {
			onChange(parsed);
		} else {
			setDraft(initial);
		}
	};
	return (
		<input
			ref={inputRef}
			type="number"
			step="0.1"
			min="0"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			aria-label="Distance"
			className="w-24 px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-text font-mono focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
		/>
	);
}

function UnitMenu({
	unit,
	setUnit,
}: {
	readonly unit: DistanceUnit;
	readonly setUnit: (unit: DistanceUnit) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items: readonly DistanceUnit[] = ["miles", "kilometers"];
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Distance unit: ${UNIT_LABELS[unit]}`}
				className="group flex items-center gap-1 px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer @max-md:justify-self-start"
			>
				<span>{UNIT_LABELS[unit]}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((u, i) => {
							const isActive = u === unit;
							const last = items.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={u}
									onClick={() => setUnit(u)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span>{UNIT_LABELS[u]}</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
