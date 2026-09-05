import type { Uuid } from "@/lib/domain";
import type { AppSetupSection } from "@/lib/routing/types";
import type { PreviewCaseChoice } from "@/lib/session/types";

/** One rendered choice of a lookup-backed select, in authored row order.
 *  `key` is the source row's stable id — lookup rows, unlike static
 *  options, guarantee neither unique nor non-blank values, so display
 *  identity (React keys, DOM ids) must never derive from `value`. */
export interface LookupChoice {
	readonly key: string;
	readonly value: string;
	readonly label: string;
}

/** Per-field reactive state tracked by the form engine. */
export interface FieldState {
	path: string;
	value: string;
	visible: boolean;
	required: boolean;
	valid: boolean;
	errorMessage?: string;
	/** Whether the user has interacted with and left this field. */
	touched: boolean;
	/** A user supplied an answer, including clearing it, before or after blur. */
	edited?: boolean;
	/** Label with hashtag refs evaluated to runtime values. Only set when the label contains refs. */
	resolvedLabel?: string;
	/** Hint with hashtag refs evaluated to runtime values. Only set when the hint contains refs. */
	resolvedHint?: string;
	/** Help text with structural refs evaluated to runtime values. */
	resolvedHelp?: string;
	/** Structural option-label refs evaluated by stable option uuid. */
	resolvedOptionLabels?: Readonly<Record<string, string>>;
	/** Live instance count for repeat fields. Only set on `repeat` kinds —
	 *  undefined elsewhere. Surfaced through `useEngineState(uuid)` so the
	 *  preview's `RepeatField` re-renders when add/remove mutates
	 *  cardinality: child-instance writes are keyed by `[N]/...` paths the
	 *  UUID-keyed runtime store doesn't track, so the repeat's own state
	 *  reference is the only signal Zustand subscribers can observe. */
	repeatCount?: number;
	/** Live filtered choices of a lookup-backed select — an engine value
	 *  (the `choices` DAG expression), recomputed when a filter dependency
	 *  changes, mirroring the device's prompt-rebuild re-filter. Only set
	 *  on `single_select` / `multi_select` fields with an `optionsSource`;
	 *  static-option selects keep reading options off the doc entity. */
	choices?: readonly LookupChoice[];
}

/** Value-equality over the ordered choice list of two states. */
export function lookupChoicesEqual(
	a: readonly LookupChoice[] | undefined,
	b: readonly LookupChoice[] | undefined,
): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return (
		a.length === b.length &&
		a.every(
			(c, i) =>
				c.key === b[i].key && c.value === b[i].value && c.label === b[i].label,
		)
	);
}

/**
 * Structural equality for `FieldState`. Callers writing back into a
 * Zustand store use this to skip the write when the new state is equal
 * by value to the current one — `validateAll` / `resetValidation` in
 * the engine controller, schema-rebuild diffing in
 * `formEngine.updateSchema`, and any future selective sync. Both stores
 * key on `===` reference equality, so an unconditional `setState` of an
 * equal-by-value-but-new-by-reference object forces spurious re-renders.
 *
 * Colocated with `FieldState` so adding a slot to the interface and
 * extending the comparison happen in one file.
 */
export function fieldStatesEqual(a: FieldState, b: FieldState): boolean {
	return (
		a.path === b.path &&
		a.value === b.value &&
		a.visible === b.visible &&
		a.required === b.required &&
		a.valid === b.valid &&
		a.touched === b.touched &&
		a.edited === b.edited &&
		a.errorMessage === b.errorMessage &&
		a.resolvedLabel === b.resolvedLabel &&
		a.resolvedHint === b.resolvedHint &&
		a.resolvedHelp === b.resolvedHelp &&
		stringRecordsEqual(a.resolvedOptionLabels, b.resolvedOptionLabels) &&
		a.repeatCount === b.repeatCount &&
		lookupChoicesEqual(a.choices, b.choices)
	);
}

export function stringRecordsEqual(
	left: Readonly<Record<string, string>> | undefined,
	right: Readonly<Record<string, string>> | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	const leftKeys = Object.keys(left);
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every((key) => left[key] === right[key])
	);
}

/** Navigation screen types for the preview. */
export type PreviewScreen =
	| { type: "home" }
	/** The Project data workspace. Uuid-free, because it names no blueprint
	 *  entity at all — Project-shared lookup tables are not app content. An
	 *  absent `tableId` is the table list. */
	| { type: "projectData"; tableId?: string }
	| { type: "module"; moduleUuid: Uuid }
	| { type: "caseList"; moduleUuid: Uuid }
	/** Per-module case-search / case-detail authoring surfaces.
	 *  Siblings to `caseList` — the three URL-addressed tabs of the
	 *  case-list workspace, with the same stable module identity. */
	| { type: "searchConfig"; moduleUuid: Uuid }
	| { type: "detailConfig"; moduleUuid: Uuid }
	/** The data review screen — a builder workspace sibling
	 *  of the config kinds above (edit-mode only; preview shows the
	 *  running case list for its URL, like the config kinds do). */
	| { type: "dataReview"; moduleUuid: Uuid }
	/** The App setup workspace — app administration, so it names no module
	 *  and has no running-app counterpart. Edit mode only: Preview leaves
	 *  it for the app home, because there is nothing here to run. */
	| { type: "appSetup"; section: AppSetupSection }
	| {
			type: "form";
			moduleUuid: Uuid;
			formUuid: Uuid;
			/** Ordered selected cases. Undefined still awaits selection; an empty
			 * array is an explicitly blank carried link. */
			cases?: readonly PreviewCaseChoice[];
	  };

/** Returns the immediate parent screen in the hierarchy, or undefined if already at home. */
export function getParentScreen(
	screen: PreviewScreen,
): PreviewScreen | undefined {
	switch (screen.type) {
		case "module":
		case "appSetup":
			return { type: "home" };
		case "caseList":
		case "searchConfig":
		case "detailConfig":
		case "dataReview":
		case "form":
			return { type: "module", moduleUuid: screen.moduleUuid };
		default:
			return undefined;
	}
}

export function screensEqual(a: PreviewScreen, b: PreviewScreen): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "home") return true;
	if (a.type === "projectData" && b.type === "projectData")
		return a.tableId === b.tableId;
	if (a.type === "module" && b.type === "module")
		return a.moduleUuid === b.moduleUuid;
	if (a.type === "caseList" && b.type === "caseList")
		return a.moduleUuid === b.moduleUuid;
	if (a.type === "searchConfig" && b.type === "searchConfig")
		return a.moduleUuid === b.moduleUuid;
	if (a.type === "detailConfig" && b.type === "detailConfig")
		return a.moduleUuid === b.moduleUuid;
	if (a.type === "dataReview" && b.type === "dataReview")
		return a.moduleUuid === b.moduleUuid;
	if (a.type === "appSetup" && b.type === "appSetup")
		return a.section === b.section;
	if (a.type === "form" && b.type === "form")
		return (
			a.moduleUuid === b.moduleUuid &&
			a.formUuid === b.formUuid &&
			previewScreenCasesEqual(a.cases, b.cases)
		);
	return false;
}

function previewScreenCasesEqual(
	left: readonly PreviewCaseChoice[] | undefined,
	right: readonly PreviewCaseChoice[] | undefined,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.length === right.length &&
			left.every(
				(choice, index) =>
					choice.caseId === right[index]?.caseId &&
					choice.caseName === right[index]?.caseName,
			))
	);
}

/** Stable string key for a PreviewScreen, suitable as a React key.
 *  Encodes the screen's type and stable entity identities so two screens at
 *  different navigation depths never collide, even if their labels match. */
export function screenKey(screen: PreviewScreen): string {
	switch (screen.type) {
		case "home":
			return "home";
		case "projectData":
			return `projectData-${screen.tableId ?? "list"}`;
		case "module":
			return `module-${screen.moduleUuid}`;
		case "caseList":
			return `caseList-${screen.moduleUuid}`;
		case "searchConfig":
			return `searchConfig-${screen.moduleUuid}`;
		case "detailConfig":
			return `detailConfig-${screen.moduleUuid}`;
		case "dataReview":
			return `dataReview-${screen.moduleUuid}`;
		case "appSetup":
			return `appSetup-${screen.section}`;
		case "form":
			return `form-${screen.moduleUuid}-${screen.formUuid}`;
	}
}
