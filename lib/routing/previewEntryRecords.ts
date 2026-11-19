/**
 * What a Preview history entry was shown with, held in memory with the
 * Preview session that showed it.
 *
 * A browser history entry outlives the page that wrote it, the signed-in
 * member and their Project membership, so its state holds identifiers and
 * the topology of the builder's steps alone (`builderHistoryState.ts`). What
 * an entry was shown with is a value of the Project's data or one the worker
 * typed: the case selections it showed (`previewSelectionsHistory.ts`), a
 * case list's held form menu (`previewHeldMenu.ts`) and the context of each
 * search standing on it, answers and hidden values among them
 * (`previewSearchHistory.ts`). Each is read only in the Preview session that
 * showed it (`previewSessionId`, new on every page load and every time the
 * session starts over), so each lives here, keyed by the entry's own id
 * (`__novaEntry`), for exactly that session.
 *
 * The session is the key of the container: a session other than the one the
 * registry holds starts an empty one and the earlier session's records are
 * let go, so a record of another session cannot be read because it is not
 * there. A session once let go is never taken up again, so a late write of
 * it (a claim answered after the worker moved on) changes nothing.
 */
import { v4 as uuidv4 } from "uuid";
import type { Uuid } from "@/lib/doc/types";
import type {
	PreviewCaseChoice,
	PreviewSearchState,
} from "@/lib/session/types";
import type { RecordedPreviewSelections } from "./previewSelectionsHistory";

/** The history state key that names an entry. Its value is an opaque id,
 *  minted for every entry a builder write makes. */
export const PREVIEW_ENTRY_STATE_KEY = "__novaEntry";

/** A case list's form menu, held with its chosen cases on the entry that
 *  shows it, and whether the entry before it is its list's. */
export interface PreviewEntryHeldMenu {
	readonly moduleUuid: Uuid;
	readonly cases: readonly PreviewCaseChoice[];
	readonly afterList?: true;
}

/** A search's context as an entry holds it: its module and the context. */
export interface RecordedPreviewSearch {
	readonly moduleUuid: string;
	readonly state: Exclude<PreviewSearchState, { kind: "not-searched" }>;
}

/** What one entry was shown with. */
export interface PreviewEntryRecord {
	readonly selections?: RecordedPreviewSelections;
	readonly heldMenu?: PreviewEntryHeldMenu;
	/** The context of each search standing on the entry, by submission. */
	readonly searches?: Readonly<Record<string, RecordedPreviewSearch>>;
}

/** The record of an entry that holds nothing. */
export const NO_PREVIEW_ENTRY_RECORD: PreviewEntryRecord = Object.freeze({});

/** One history entry as the builder reads it: the state the browser keeps,
 *  and the record the running Preview session holds of it. */
export interface PreviewHistoryEntry {
	readonly state: Record<string, unknown>;
	readonly record: PreviewEntryRecord;
}

/** The record of an entry, by its id, in one session's records. An entry
 *  with no id, or one the records do not hold, holds nothing. */
export type PreviewEntryRecordOf = (
	entry: string | undefined,
) => PreviewEntryRecord;

/** The id a history entry's state names it by, or none. */
export function previewEntryOf(state: unknown): string | undefined {
	if (typeof state !== "object" || state === null) return undefined;
	const entry = (state as Record<string, unknown>)[PREVIEW_ENTRY_STATE_KEY];
	return typeof entry === "string" && entry !== "" ? entry : undefined;
}

/** A new entry's id. `uuid` draws on `crypto.getRandomValues`, which every
 *  browsing context holds. */
export function newPreviewEntry(): string {
	return uuidv4();
}

/** A reader over one session's records. */
export function previewEntryRecordReader(
	records: ReadonlyMap<string, PreviewEntryRecord>,
): PreviewEntryRecordOf {
	return (entry) =>
		(entry === undefined ? undefined : records.get(entry)) ??
		NO_PREVIEW_ENTRY_RECORD;
}

interface Registry {
	readonly session: string | undefined;
	readonly records: Map<string, PreviewEntryRecord>;
}

let registry: Registry = { session: undefined, records: new Map() };
/** Every session the registry has let go. */
const letGo = new Set<string>();

/** The records of `session`, to write into: a session other than the one
 *  held starts an empty registry and lets the earlier one's go. A session
 *  already let go gets records no one reads again. */
export function previewEntryRecordsToWrite(
	session: string,
): Map<string, PreviewEntryRecord> {
	if (registry.session === session) return registry.records;
	if (letGo.has(session)) return new Map();
	if (registry.session !== undefined) letGo.add(registry.session);
	registry = { session, records: new Map() };
	return registry.records;
}

/** The records of `session`, to read: none where the registry holds another
 *  session's. Reading never lets a session go, so a render still holding
 *  an earlier session's id cannot drop the running one's records. */
export function previewEntryRecordsToRead(
	session: string,
): ReadonlyMap<string, PreviewEntryRecord> {
	return registry.session === session ? registry.records : EMPTY_RECORDS;
}

const EMPTY_RECORDS: ReadonlyMap<string, PreviewEntryRecord> = new Map();

/** The records the registry holds now, whichever session's: a write that
 *  carries an entry's record on to the next entry reads it and files the
 *  next one here, without knowing the session, so it stays in the session
 *  it came from, which a session that asks next lets go if it is another. */
export function heldPreviewEntryRecords(): Map<string, PreviewEntryRecord> {
	return registry.records;
}
