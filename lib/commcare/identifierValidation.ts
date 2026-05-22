/** Validation helpers for CommCare identifiers. */

import {
	CASE_TYPE_REGEX,
	RESERVED_CASE_PROPERTIES,
	RESERVED_XFORM_NODE_PREFIX,
	XFORM_PATH_REGEX,
	XML_ELEMENT_NAME_REGEX,
} from "./constants";

/** Validate a CommCare case type identifier. Throws on invalid. */
export function validateCaseType(ct: string): string {
	if (!CASE_TYPE_REGEX.test(ct)) {
		throw new Error(`Invalid case type: "${ct}"`);
	}
	return ct;
}

/** Validate an XForm data path (e.g. /data/name). Throws on invalid. */
export function validateXFormPath(p: string): string {
	if (!XFORM_PATH_REGEX.test(p)) {
		throw new Error(`Invalid XForm path: "${p}"`);
	}
	return p;
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
 * Returns true if the XForm node name falls under Nova's reserved
 * synthetic-node namespace (the `__nova_` prefix). The XForm emitter
 * generates nodes under this prefix (e.g. the hidden counter a hoisted
 * `count_bound` repeat needs), so an authored field id here would collide
 * with a synthesized node. Parallel to `isReservedProperty`, but for the
 * XForm element-name namespace rather than the case-property namespace.
 */
export function isReservedXFormNodeName(name: string): boolean {
	return name.startsWith(RESERVED_XFORM_NODE_PREFIX);
}

/** Convert a display name to a valid snake_case identifier (alphanumeric, starts with a letter). */
export function toSnakeId(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_|_$/g, "")
			.replace(/^(\d)/, "_$1") || "unnamed"
	);
}
