/**
 * A pure function's answers over texts, held by the text.
 *
 * A reading of a CommCare HQ app asks the same question of one text many
 * times over. A form's XForm text is read from the source as the reading
 * starts, beside the reader's entry facts and in acceptance's identity check,
 * and Nova's emission of the same forms is read again by the fixed point. An
 * XPath text an app repeats across its menus is read by the grammar at each
 * place it stands. Each answer is a function of the text alone, so a text met
 * again is answered without a second parse. A string is a value no one can
 * change, so a held answer is never stale; the caller's answers are frozen
 * read-only records, and a held outcome may be a thrown reason, which is
 * thrown again.
 *
 * Texts are kept in the order they were first asked, and the oldest are
 * dropped once those held pass `heldCharacters`, so what is held stays within
 * a bound whatever reads pass through.
 */
export class HeldByText<T> {
	private readonly held = new Map<string, T>();
	private characters = 0;

	constructor(private readonly heldCharacters: number) {}

	/** `answer(text)`, or the answer it gave this text before. */
	of(text: string, answer: (text: string) => T): T {
		const known = this.held.get(text);
		if (known !== undefined || this.held.has(text)) return known as T;
		const found = answer(text);
		this.held.set(text, found);
		this.characters += text.length;
		for (const [oldest] of this.held) {
			if (this.characters <= this.heldCharacters) break;
			this.held.delete(oldest);
			this.characters -= oldest.length;
		}
		return found;
	}
}

/** About two apps at the bring-in byte cap (`HQ_BRING_IN_APP_MAX_BYTES`): the
 *  source and Nova's emission of it, each read several times by one reading. */
export const FORM_TEXTS_HELD_CHARACTERS = 40 * 1024 * 1024;

/** The XPath texts the reader's grammar reads: a reading's distinct texts are
 *  a small part of its app, and each held tree is some tens of bytes for each
 *  character of its text. */
export const SYNTAX_TEXTS_HELD_CHARACTERS = 1024 * 1024;
