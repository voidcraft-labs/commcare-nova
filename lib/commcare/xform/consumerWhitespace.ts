/**
 * A run of text a consumer of a form drops before it reads a label: Core
 * removes a text node whose Java `String.trim()` result is empty
 * (`XFormParser.getXMLDocument`), and HQ's lxml indent replaces a
 * whitespace-only tail by Python's `isspace`. The emitter writes such a run
 * as a literal output instead of a text node, and the reader of HQ's forms
 * reads a text node of such a run as nothing, so both sides hold this one
 * definition.
 */
export function isConsumerWhitespace(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (
			unit > 0x20 &&
			unit !== 0x85 &&
			unit !== 0xa0 &&
			unit !== 0x1680 &&
			!(unit >= 0x2000 && unit <= 0x200a) &&
			unit !== 0x2028 &&
			unit !== 0x2029 &&
			unit !== 0x202f &&
			unit !== 0x205f &&
			unit !== 0x3000
		) {
			return false;
		}
	}
	return true;
}
