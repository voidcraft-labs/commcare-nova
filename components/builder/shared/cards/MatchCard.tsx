// components/builder/shared/cards/MatchCard.tsx
//
// Renders the `match` predicate. Property dropdown (text-shaped or
// — for `fuzzy-date` — date / datetime), value input (typed by
// the property), and mode dropdown (fuzzy / phonetic / fuzzy-date
// / starts-with).

"use client";
import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import type { CaseProperty } from "@/lib/domain";
import { isDateTyped, isTextShaped } from "@/lib/domain";
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
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";

/** Module-level filters so render-time identity stays stable per
 *  match mode — `PropertyPicker`'s `useMemo` on
 *  `[caseType, filter]` invalidates on each fresh-arrow filter
 *  even when the per-mode selection rule is constant.
 *
 *  Three of the four modes (`fuzzy` / `phonetic` / `starts-with`)
 *  share the text-shaped allow-list; `fuzzy-date` widens to
 *  additionally accept date / datetime properties. The card picks
 *  one of the two filters based on the current mode without
 *  allocating a fresh closure. The shared `isTextShaped` /
 *  `isDateTyped` helpers (in `lib/domain/casePropertyTypes.ts`)
 *  consolidate the `data_type ?? "text"` fallback every consumer
 *  applies. */
const MATCH_TEXT_SHAPED_FILTER = (p: CaseProperty): boolean => isTextShaped(p);

const MATCH_FUZZY_DATE_FILTER = (p: CaseProperty): boolean =>
	isTextShaped(p) || isDateTyped(p);

/** Plain-words mode names, matching the search-input Match picker's
 *  vocabulary (`SEARCH_MODE_LABELS`) so the simple and advanced arms
 *  never call the same behavior two different things. */
const MODE_LABELS: Record<MatchMode, { label: string; description: string }> = {
	fuzzy: {
		label: "Fuzzy",
		description: "Forgives a typo or two per word; ignores capitalization",
	},
	phonetic: {
		label: "Sounds like",
		description: "Names that sound alike when spoken — Smith finds Smyth",
	},
	"fuzzy-date": {
		label: "Fuzzy date",
		description: "Forgives swapped day and month, and mistyped digits",
	},
	"starts-with": {
		label: "Starts with",
		description: "Values beginning with the text — capitalization counts",
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
	const property = ct?.properties.find(isTextShaped);
	const propName = property?.name ?? "";
	return match(prop(ctx.currentCaseType, propName), literal(""), "fuzzy");
}

interface MatchCardProps {
	readonly value: Extract<Predicate, { kind: "match" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function MatchCard({ value, onChange, path }: MatchCardProps) {
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));

	const setProperty = (next: PropertyRef) => {
		onChange(match(next, value.value, value.mode));
	};

	const setMode = (mode: MatchMode) => {
		onChange(match(value.property, value.value, mode));
	};

	const setValue = (next: Parameters<typeof match>[1]) => {
		onChange(match(value.property, next, value.mode));
	};

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
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto_1.6fr] gap-2 items-start">
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
					{/* Match value routes through `ExpressionPicker` so the
					 *  full ValueExpression family is reachable at the
					 *  slot. The picker's own `CardShell` footer surfaces
					 *  inline errors at the slot path, so no parallel
					 *  `<InlineError>` is needed here.
					 *
					 *  `expectedType` mirrors the type checker's per-mode
					 *  allow-list (`MATCH_PROPERTY_TYPES_BY_MODE`) — three
					 *  modes accept text-shaped values; `fuzzy-date` widens
					 *  to date as well. The hint is a primitive type, so
					 *  it can't capture the multi-arm disjunction
					 *  precisely; passing `text` for the three text-shaped
					 *  modes and `date` for `fuzzy-date` is the closest
					 *  primitive narrowing the picker's kind menu can
					 *  surface. */}
					<ExpressionPicker
						value={value.value}
						onChange={setValue}
						path={appendSlot(path, "value")}
						expectedType={value.mode === "fuzzy-date" ? "date" : "text"}
						variant="nested"
					/>
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
				className="group flex items-center gap-1 px-3 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer @max-md:justify-self-start"
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
