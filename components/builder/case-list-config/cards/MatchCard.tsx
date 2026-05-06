// components/builder/case-list-config/cards/MatchCard.tsx
//
// Renders the `match` predicate. Property dropdown (text-shaped or
// — for `fuzzy-date` — date / datetime), value input (typed by
// the property), and mode dropdown (fuzzy / phonetic / fuzzy-date
// / starts-with).

"use client";
import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import {
	literal,
	type MatchMode,
	match,
	type Predicate,
	type PropertyRef,
	prop,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import {
	useEditorErrorsAt,
	useEditorErrorsAtOrBelow,
	usePredicateEditContext,
} from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { ValueExpressionPicker } from "../primitives/ValueExpressionPicker";

const TEXT_SHAPED = new Set<string>(["text", "single_select", "multi_select"]);

/** Module-level filters so render-time identity stays stable per
 *  match mode — `PropertyPicker`'s `useMemo` on
 *  `[caseType, filter]` invalidates on each fresh-arrow filter
 *  even when the per-mode selection rule is constant.
 *
 *  Three of the four modes (`fuzzy` / `phonetic` / `starts-with`)
 *  share the text-shaped allow-list; `fuzzy-date` widens to
 *  additionally accept date / datetime properties. The card picks
 *  one of the two filters based on the current mode without
 *  allocating a fresh closure. */
const MATCH_TEXT_SHAPED_FILTER = (p: { data_type?: string }): boolean =>
	TEXT_SHAPED.has(p.data_type ?? "text");

const MATCH_FUZZY_DATE_FILTER = (p: { data_type?: string }): boolean =>
	TEXT_SHAPED.has(p.data_type ?? "text") ||
	p.data_type === "date" ||
	p.data_type === "datetime";

const MODE_LABELS: Record<MatchMode, { label: string; description: string }> = {
	fuzzy: {
		label: "Fuzzy",
		description: "Edit-distance match — tolerates typos",
	},
	phonetic: {
		label: "Phonetic",
		description: "Sounds-like match",
	},
	"fuzzy-date": {
		label: "Fuzzy date",
		description: "Recovers from transposed YYYY-MM-DD inputs",
	},
	"starts-with": {
		label: "Starts with",
		description: "Prefix match",
	},
};

const ALL_MODES: readonly MatchMode[] = [
	"fuzzy",
	"phonetic",
	"starts-with",
	"fuzzy-date",
];

export function matchDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "match" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) =>
		TEXT_SHAPED.has(p.data_type ?? "text"),
	);
	const propName = property?.name ?? "";
	return match(prop(ctx.currentCaseType, propName), literal(""), "fuzzy");
}

interface MatchCardProps {
	readonly value: Extract<Predicate, { kind: "match" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function MatchCard({ value, onChange, path }: MatchCardProps) {
	const ctx = usePredicateEditContext();
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));
	// `match` is the only predicate whose type checker emits errors at
	// a path *deeper* than the operator's value slot — term-resolution
	// failures on `match.value.term` land at `[..., "value", "term"]`,
	// while operator-level mode-mismatch errors land at
	// `[..., "value"]`. Capture both with the prefix lookup so an
	// Unknown-property / Unknown-input failure on the value picker
	// surfaces inline next to the input rather than only flipping the
	// parent's save gate. See `checkMatch` in
	// `lib/domain/predicate/typeChecker.ts` for the path emission.
	const valueErrors = useEditorErrorsAtOrBelow(appendSlot(path, "value"));

	const setProperty = (next: PropertyRef) => {
		onChange(match(next, value.value, value.mode));
	};

	const setMode = (mode: MatchMode) => {
		onChange(match(value.property, value.value, mode));
	};

	const setValue = (next: Parameters<typeof match>[1]) => {
		onChange(match(value.property, next, value.mode));
	};

	const propertyName = value.property.property || undefined;

	// Filter the property picker to the mode's allow-list. The
	// type checker enforces the same rule; gating the picker in the
	// UI prevents the author from picking a property that would
	// immediately fail validation. Picks one of the two module-
	// level filters so render-time identity stays stable for the
	// downstream `useMemo` in `PropertyPicker`.
	const propertyFilter =
		value.mode === "fuzzy-date"
			? MATCH_FUZZY_DATE_FILTER
			: MATCH_TEXT_SHAPED_FILTER;

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-[1.4fr_auto_1.6fr] gap-2 items-start">
				<div>
					<PropertyRefPicker
						mode="property-only"
						value={value.property}
						onChange={setProperty}
						filter={propertyFilter}
						invalid={propertyErrors.length > 0}
						ariaLabel="Property"
					/>
					<InlineError errors={propertyErrors} />
				</div>

				<ModeMenu mode={value.mode} setMode={setMode} />

				<div>
					<ValueExpressionPicker
						value={value.value}
						onChange={setValue}
						caseTypeName={ctx.currentCaseType}
						anchorPropertyName={propertyName}
						invalid={valueErrors.length > 0}
						ariaLabel="Match value"
					/>
					<InlineError errors={valueErrors} />
				</div>
			</div>
		</div>
	);
}

function ModeMenu({
	mode,
	setMode,
}: {
	readonly mode: MatchMode;
	readonly setMode: (mode: MatchMode) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = MODE_LABELS[mode];

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Match mode: ${current.label}`}
				className="group flex items-center gap-1 px-3 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<span>{current.label}</span>
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
					align="center"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{ALL_MODES.map((m, i) => {
							const isActive = m === mode;
							const last = ALL_MODES.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const meta = MODE_LABELS[m];
							return (
								<Menu.Item
									key={m}
									onClick={() => setMode(m)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span className="flex-1 text-left">
										<div>{meta.label}</div>
										<div
											className={`text-[10px] ${
												isActive
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{meta.description}
										</div>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
