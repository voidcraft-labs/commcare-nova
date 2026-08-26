/**
 * JavaRosa's lexer changes from value mode to operator mode after a complete
 * expression. In operator mode the word operators are prefixes, so `3mod4`
 * and `4andfunc()` are valid even without separating whitespace. Lezer's
 * parser state gives us the same context: these external tokens are only
 * requested where an infix operator is legal.
 */
import { ExternalTokenizer } from "@lezer/lr";
import { AndOp, DivOp, ModOp, OrOp } from "./parser.terms";

const OPERATORS = [
	["and", AndOp],
	["or", OrOp],
	["div", DivOp],
	["mod", ModOp],
] as const;

export const coreOperatorTokens = new ExternalTokenizer((input) => {
	for (const [word, term] of OPERATORS) {
		let matches = true;
		for (let index = 0; index < word.length; index += 1) {
			if (input.peek(index) !== word.charCodeAt(index)) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		for (let index = 0; index < word.length; index += 1) input.advance();
		input.acceptToken(term);
		return;
	}
});
