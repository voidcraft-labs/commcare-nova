/**
 * The reader's one door to the XPath grammar: every text a stage reads with
 * `readFormSyntax` goes through here, so a reading counts each such read in
 * its `ReadWork` (`syntaxReads`). The count goes to the accounting of the
 * reading in progress (`countingSyntaxReads`, which `readHqApp` runs its
 * stages under); a read outside one, as in a test that calls a stage's helper
 * on its own, is counted nowhere. The scope is set and restored around one
 * synchronous reading, so no count outlives the reading that made it.
 */

import {
	type FormSyntaxResult,
	readFormSyntax as readSyntax,
} from "../xpath/formSyntax";

/** The counter of the reading in progress, or undefined outside one. */
let current: { noteSyntaxRead(): void } | undefined;

/** `text` read with the XPath grammar, counted against the reading in progress. */
export function readFormSyntax(text: string): FormSyntaxResult {
	current?.noteSyntaxRead();
	return readSyntax(text);
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
