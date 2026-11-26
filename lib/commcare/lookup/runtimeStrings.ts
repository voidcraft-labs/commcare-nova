/** JavaRosa stores fixture text and attributes with ExtUtil.writeString.
 * DataOutputStream.writeUTF allows an unsigned 16-bit modified UTF-8 length.
 * Supplementary characters take six bytes because Java encodes their two
 * UTF-16 code units separately. Formplayer's fixture SqlStorage uses the
 * same externalizer. */
export const MAX_LOOKUP_RUNTIME_STRING_BYTES = 65_535;

export function lookupRuntimeStringBytes(value: string): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		bytes += unit !== 0 && unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
	}
	return bytes;
}

export function lookupRuntimeStringTooLong(value: string): boolean {
	return lookupRuntimeStringBytes(value) > MAX_LOOKUP_RUNTIME_STRING_BYTES;
}

export const LOOKUP_RUNTIME_STRING_LIMIT_LINE =
	"CommCare cannot load a lookup value this long. You can shorten the value in Project data.";

export class LookupRuntimeValueLimit extends Error {
	readonly name = "LookupRuntimeValueLimit";

	constructor() {
		super(LOOKUP_RUNTIME_STRING_LIMIT_LINE);
	}
}
