/**
 * The reader's one door to the XPath grammar: every text a stage reads with
 * `readFormSyntax` goes through here, so a reading counts each such read in
 * its `ReadWork` (`syntaxReads`). The count goes to the accounting of the
 * reading in progress (`countingSyntaxReads`, which `readHqApp` runs its
 * stages under); a read outside one, as in a test that calls a stage's helper
 * on its own, is counted nowhere. The scope is set and restored around one
 * synchronous reading, so no count outlives the reading that made it.
 *
 * The grammar's answer is a function of the text alone, so a text read again
 * is answered from the tree it gave before (`heldByText.ts`) without a second
 * parse; each read is counted all the same. Every read is given its own copy
 * of that tree, as a fresh parse gives, since a stage may tell two reads'
 * nodes apart by identity (`expressions/readExpression.ts`' plain nodes).
 */

import { HeldByText, SYNTAX_TEXTS_HELD_CHARACTERS } from "../heldByText";
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
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(source)) out[key] = copied(source[key]);
	return out as T;
}

/** The counter of the reading in progress, or undefined outside one. */
let current: { noteSyntaxRead(): void } | undefined;

/** `text` read with the XPath grammar, counted against the reading in progress. */
export function readFormSyntax(text: string): FormSyntaxResult {
	current?.noteSyntaxRead();
	return copied(
		heldReadings.of(text, (source) => frozenWhole(readSyntax(source))),
	);
}

/** `text` read with the XPath grammar, counted as `readFormSyntax` counts it, as the frozen tree
 *  every read of the text shares: for a reader that only walks it and tells no two reads' nodes
 *  apart (the uses a text's syntax makes). */
export function sharedFormSyntax(text: string): FormSyntaxResult {
	current?.noteSyntaxRead();
	return heldReadings.of(text, (source) => frozenWhole(readSyntax(source)));
}

/** `run`'s answer, every grammar read it makes through this module counted by `counter`. */
export function countingSyntaxReads<T>(
	counter: { noteSyntaxRead(): void },
	run: () => T,
): T {
	const outer = current;
	current = counter;
	try {
		return run();
	} finally {
		current = outer;
	}
}
