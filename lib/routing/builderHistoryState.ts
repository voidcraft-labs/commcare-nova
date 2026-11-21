/**
 * What the builder may keep in a browser history entry's state.
 *
 * A history entry outlives the page that wrote it, the signed-in member and
 * their Project membership: it stays in the tab until the tab's history is
 * gone. So the builder keeps there identifiers and the topology of its steps
 * alone, never a value read from the Project's data or typed by the worker.
 * What an entry was shown with is held in memory with the Preview session
 * that showed it (`previewEntryRecords.ts`).
 *
 * `BuilderHistoryState` is the closed set of what the builder writes, and
 * `sealedBuilderHistoryState` is the one way a state reaches the browser
 * (`useClientPath.ts` writes nothing else): each of the builder's keys is
 * kept only as its own shape, every other builder key is dropped, and the
 * keys the framework keeps on the entry (Next's router's) pass through.
 */
import { PREVIEW_ENTRY_STATE_KEY } from "./previewEntryRecords";

/** The Project generation an entry was written under. */
export interface BuilderHistoryScope {
	scopeId: string;
	appId: string | null;
	epoch: number;
}

export const PROJECT_SCOPE_STATE_KEY = "__novaProjectScope";
export const PREVIOUS_ENTRY_STATE_KEY = "__novaPreviousEntry";
export const PREVIOUS_GAP_STATE_KEY = "__novaPreviousGap";
export const STANDING_SEARCHES_STATE_KEY = "__novaPreviewSearches";
export const SEARCHES_END_STATE_KEY = "__novaPreviewSearchesEnd";

/** Every key the builder writes into a history entry's state. */
export interface BuilderHistoryState {
	/** The Project generation the entry was written under. */
	readonly [PROJECT_SCOPE_STATE_KEY]?: BuilderHistoryScope;
	/** The entry's own id (`previewEntryRecords.ts`). */
	readonly [PREVIEW_ENTRY_STATE_KEY]?: string;
	/** The entry this one was pushed after: its path and its id. */
	readonly [PREVIOUS_ENTRY_STATE_KEY]?: {
		readonly path: string;
		readonly entry?: string;
	};
	/** How many entries lie between this one and the one it records. */
	readonly [PREVIOUS_GAP_STATE_KEY]?: number;
	/** The searches standing on the entry, by submission id. */
	readonly [STANDING_SEARCHES_STATE_KEY]?: readonly string[];
	/** The searches a submission on the entry leaves its next step. */
	readonly [SEARCHES_END_STATE_KEY]?: readonly string[];
}

const BUILDER_KEY_PREFIX = "__nova";

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The Project generation a state was written under, or none. */
export function readBuilderHistoryScope(
	state: unknown,
): BuilderHistoryScope | null {
	const stamp = recordOf(recordOf(state)?.[PROJECT_SCOPE_STATE_KEY]);
	if (
		stamp === undefined ||
		typeof stamp.scopeId !== "string" ||
		!(stamp.appId === null || typeof stamp.appId === "string") ||
		typeof stamp.epoch !== "number"
	)
		return null;
	return { scopeId: stamp.scopeId, appId: stamp.appId, epoch: stamp.epoch };
}

function stringsOf(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? [...value]
		: undefined;
}

function previousOf(
	value: unknown,
): BuilderHistoryState[typeof PREVIOUS_ENTRY_STATE_KEY] {
	const previous = recordOf(value);
	if (previous === undefined || typeof previous.path !== "string")
		return undefined;
	return {
		path: previous.path,
		...(typeof previous.entry === "string" &&
			previous.entry !== "" && { entry: previous.entry }),
	};
}

/** The builder's keys of a state, each as its own shape. */
export function builderHistoryStateOf(state: unknown): BuilderHistoryState {
	const record = recordOf(state);
	if (record === undefined) return {};
	const scope = readBuilderHistoryScope(record);
	const entry = record[PREVIEW_ENTRY_STATE_KEY];
	const previous = previousOf(record[PREVIOUS_ENTRY_STATE_KEY]);
	const gap = record[PREVIOUS_GAP_STATE_KEY];
	const standing = stringsOf(record[STANDING_SEARCHES_STATE_KEY]);
	const end = stringsOf(record[SEARCHES_END_STATE_KEY]);
	return {
		...(scope !== null && { [PROJECT_SCOPE_STATE_KEY]: scope }),
		...(typeof entry === "string" &&
			entry !== "" && { [PREVIEW_ENTRY_STATE_KEY]: entry }),
		...(previous !== undefined && { [PREVIOUS_ENTRY_STATE_KEY]: previous }),
		...(typeof gap === "number" &&
			Number.isSafeInteger(gap) &&
			gap > 0 && { [PREVIOUS_GAP_STATE_KEY]: gap }),
		...(standing !== undefined && { [STANDING_SEARCHES_STATE_KEY]: standing }),
		...(end !== undefined && { [SEARCHES_END_STATE_KEY]: end }),
	};
}

/** The state the builder writes for `state`: the framework's own keys as
 *  they are, and of the builder's only those `BuilderHistoryState` names,
 *  each as its own shape. */
export function sealedBuilderHistoryState(
	state: unknown,
): Record<string, unknown> {
	const foreign = Object.fromEntries(
		Object.entries(recordOf(state) ?? {}).filter(
			([key]) => !key.startsWith(BUILDER_KEY_PREFIX),
		),
	);
	return { ...foreign, ...builderHistoryStateOf(state) };
}
