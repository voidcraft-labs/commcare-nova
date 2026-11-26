import type { LookupTableDefinition } from "@/lib/lookup/types";
import { validationError } from "../validator/errors";
import { lookupTableManagedInDomain } from "./xmlText";

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
	return (
		value.length > MAX_LOOKUP_RUNTIME_STRING_BYTES / 3 &&
		(value.length > MAX_LOOKUP_RUNTIME_STRING_BYTES ||
			lookupRuntimeStringBytes(value) > MAX_LOOKUP_RUNTIME_STRING_BYTES)
	);
}

export const LOOKUP_RUNTIME_STRING_LIMIT_LINE =
	"CommCare cannot load a lookup value this long. You can shorten the value in Project data.";

export class LookupRuntimeValueLimit extends Error {
	readonly name = "LookupRuntimeValueLimit";

	constructor() {
		super(LOOKUP_RUNTIME_STRING_LIMIT_LINE);
	}
}

export function lookupRuntimeValueFinding(table: LookupTableDefinition) {
	const managedInDomain = lookupTableManagedInDomain(table);
	return validationError(
		"LOOKUP_CELL_TEXT_UNREPRESENTABLE",
		"app",
		`“${table.name}” contains a lookup value too long for CommCare to load. ${
			managedInDomain
				? `You can shorten it in ${managedInDomain}, then refresh this table in Nova.`
				: "You can shorten the value in Project data."
		}`,
		{},
		{
			tableId: table.id,
			tableName: table.name,
			problem: "runtime-value-length",
			...(managedInDomain !== undefined && { managedInDomain }),
		},
	);
}
