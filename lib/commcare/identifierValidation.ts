/** Validation helpers for CommCare identifiers. */

import {
	CASE_TYPE_REGEX,
	RESERVED_CASE_PROPERTIES,
	XML_ELEMENT_NAME_REGEX,
} from "./constants";
import { FormPath } from "./xform/formPath";

/** Validate a CommCare case type identifier. Throws on invalid. */
export function validateCaseType(ct: string): string {
	if (!CASE_TYPE_REGEX.test(ct)) {
		throw new Error(`Invalid case type: "${ct}"`);
	}
	return ct;
}

/** Validate an XForm data path (e.g. /data/name). Throws on invalid. */
export function validateXFormPath(p: string): string {
	try {
		const path = FormPath.parse(p);
		if (path.segments().length === 1 || path.endsInAttribute()) {
			throw new Error("An answer path must name a non-root element");
		}
		return path.toXPath();
	} catch (cause) {
		throw new Error(`Invalid XForm path: "${p}"`, { cause });
	}
}

/** Validate an XML element / case property name. Throws on invalid. */
export function validatePropertyName(name: string): string {
	if (!XML_ELEMENT_NAME_REGEX.test(name)) {
		throw new Error(`Invalid property name: "${name}"`);
	}
	return name;
}

/** Returns true if the name is a reserved case property. */
export function isReservedProperty(name: string): boolean {
	return RESERVED_CASE_PROPERTIES.has(name);
}

/**
 * A display name's words as lowercase snake_case: every run of characters
 * other than a letter or a digit becomes one underscore, the edges trimmed,
 * `unnamed` when nothing survives. It may start with a digit; a minter that
 * needs an identifier runs it through `editorSafeQuestionId`.
 */
export function toSnakeId(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_|_$/g, "") || "unnamed"
	);
}
