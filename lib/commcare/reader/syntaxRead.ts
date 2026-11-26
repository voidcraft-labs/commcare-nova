/**
 * The reader's one door to the XPath grammar: every text a stage reads with
 * `readFormSyntax` goes through here, so a reading counts each such read in
 * its `ReadWork` (`syntaxReads`) and charges its characters to the work meter
 * (`workMeter.ts`, kind `parse`) of the piece running now, which `readHqApp`
 * sets around each part of a stage; a read outside one, as in a test that
 * calls a stage's helper on its own, is counted nowhere.
 *
 * The grammar's answer is a function of the text alone, so a text read again
 * is answered from the tree it gave before (`heldByText.ts`) without a second
 * parse; each read is counted and charged all the same, since it copies the
 * tree. Every read is given its own copy of that tree, as a fresh parse gives,
 * since a stage may tell two reads' nodes apart by identity
 * (`expressions/readExpression.ts`' plain nodes).
 */

import { HeldByText, SYNTAX_TEXTS_HELD_CHARACTERS } from "../heldByText";
import { chargeSyntaxRead } from "../workMeter";
import {
	type FormSyntaxResult,
	readFormSyntax as readSyntax,
} from "../xpath/formSyntax";

/** Each text's reading by the grammar. */
const heldReadings = new HeldByText<FormSyntaxResult>(
	SYNTAX_TEXTS_HELD_CHARACTERS,
);

/** `value` and every object it holds, frozen. */
function frozenWhole<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) frozenWhole(child);
	return Object.freeze(value);
}

/** A copy of a held reading: new arrays and records all the way down, as a
 *  parse of the same text builds. */
function copied<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) {
		const out: unknown[] = new Array(value.length);
		for (let index = 0; index < value.length; index++)
			out[index] = copied(value[index]);
		return out as T;
	}
	const source = value as Record<string, unknown>;
	const out = Object.create(Object.getPrototypeOf(source)) as Record<
		string,
		unknown
	>;
	for (const key of Object.keys(source)) out[key] = copied(source[key]);
	return out as T;
}

/** `text` read with the XPath grammar, counted against the reading in progress. */
export function readFormSyntax(text: string): FormSyntaxResult {
	chargeSyntaxRead(text.length);
	return copied(
		heldReadings.of(text, (source) => frozenWhole(readSyntax(source))),
	);
}

/** `text` read with the XPath grammar, counted as `readFormSyntax` counts it, as the frozen tree
 *  every read of the text shares: for a reader that only walks it and tells no two reads' nodes
 *  apart (the uses a text's syntax makes). */
export function sharedFormSyntax(text: string): FormSyntaxResult {
	chargeSyntaxRead(text.length);
	return heldReadings.of(text, (source) => frozenWhole(readSyntax(source)));
}

/** The grammar including stored XML names, for attributing a broken read.
 * The ordinary parse and its cache always use the worker alphabet. */
export function readStoredNameSyntax(text: string): FormSyntaxResult {
	chargeSyntaxRead(text.length);
	return readSyntax(text, "stored-xml");
}
