/**
 * Where Nova holds values under a name a source supplies: a language code, a
 * case property, a case type, a column's field or format, a form or menu id,
 * a translation key, a media path, a lookup table's tag.
 *
 * An object made by `{}` or `Object.fromEntries` has `Object.prototype`, so
 * it answers every name that prototype holds (`constructor`, `toString`,
 * `hasOwnProperty`) as if it were an entry, and an assignment under
 * `__proto__` replaces its prototype instead of adding an entry. A source
 * that names one would read a function where nothing is held, or lose the
 * entry it wrote. So:
 *
 * - a fixed table looked up by such a name is a `SourceTable`, a
 *   `ReadonlyMap` made by `tableOf`: `TABLE[name]` does not typecheck on one,
 *   and `get` answers only its own entries;
 * - a record built under such names is made by
 *   `lib/domain/records.ts::recordFromEntries`, the one way Nova builds a
 *   record keyed by names it does not choose: it has no prototype, so an
 *   index answers only what was put under that name, `__proto__` included,
 *   and it serializes as the JSON a plain object holding the same entries
 *   does; an absent record reads as `NO_ENTRIES`;
 * - a record Nova did not build (a stored document, a record a caller
 *   passes) is read under such a name through `ownRecordValue`, which asks
 *   for its own keys only.
 *
 * Every object of CommCare HQ's JSON already comes in with no prototype
 * (`hq/jsonText.ts::parseHqJsonText`), and so does every element's attributes
 * (`xmlParse.ts`). `lib/lint/sourceKeyedRecord.grit` refuses the forms that
 * build a record with a prototype where the reader, the HQ client and the
 * reading code work.
 *
 * Client-safe: no import.
 */

/** A fixed table the reader looks a source's name up in. */
export type SourceTable<V> = ReadonlyMap<string, V>;

/** The table of `entries`, each answered by `get` and nothing else. */
export function tableOf<V>(
	entries: Readonly<Record<string, V>>,
): SourceTable<V> {
	return new Map(Object.entries(entries));
}
