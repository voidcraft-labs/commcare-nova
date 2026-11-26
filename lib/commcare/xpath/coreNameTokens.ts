import { ExternalTokenizer, type InputStream } from "@lezer/lr";
import {
	isPortableNameContinuation,
	isPortableNameStart,
} from "@/lib/domain/portableName";
import { LOOKUP_WIRE_IDENTIFIER_PATTERN } from "@/lib/lookup/constants";
import {
	localName,
	qualifiedName,
	qualifiedWildcard,
	VariableReference,
} from "./parser.terms";

// Every name permitted on a supported declaration parses on the build JVM.
// Admission checks the actual worker platforms after binding the reference.
const BUILD_JVM = ["web-apps"] as const;

type NameLength = (
	input: InputStream,
	offset: number,
	start: boolean,
) => number;

const coreLength: NameLength = (input, offset, start) => {
	const unit = input.peek(offset);
	return Number(
		start
			? isPortableNameStart(unit, BUILD_JVM)
			: isPortableNameContinuation(unit, BUILD_JVM),
	);
};

/** Only for reading a stored XML name whose path a worker cannot evaluate.
 * A diagnostic parse may identify the table a source attempted to read. It
 * never supplies an admitted expression. */
const xmlLength: NameLength = (input, offset, start) => {
	const first = input.peek(offset);
	if (first < 0) return 0;
	let character = String.fromCharCode(first);
	if (first >= 0xd800 && first <= 0xdbff) {
		const second = input.peek(offset + 1);
		if (second >= 0xdc00 && second <= 0xdfff)
			character += String.fromCharCode(second);
	}
	return LOOKUP_WIRE_IDENTIFIER_PATTERN.test(
		start ? character : `a${character}`,
	)
		? character.length
		: 0;
};

function names(length: NameLength): ExternalTokenizer {
	return new ExternalTokenizer((input) => {
		const variable = input.next === 36; // $
		if (variable) input.advance();
		const initial = length(input, 0, true);
		if (!initial) return;
		const consume = (first: number) => {
			input.advance(first);
			let next = length(input, 0, false);
			while (next > 0) {
				input.advance(next);
				next = length(input, 0, false);
			}
		};
		consume(initial);
		let token = localName;
		if (input.next === 58) {
			// A single colon joins names; the grammar owns "::".
			const second = length(input, 1, true);
			if (second) {
				input.advance();
				consume(second);
				token = qualifiedName;
			} else if (!variable && input.peek(1) === 42) {
				input.advance(2);
				token = qualifiedWildcard;
			}
		}
		input.acceptToken(variable ? VariableReference : token);
	});
}

export const coreNameTokens = names(coreLength);
export const storedNameTokens = names(xmlLength);
