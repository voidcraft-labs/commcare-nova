import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import { walkPredicateNodes } from "@/lib/domain/predicate/walk";

// Geopoint text normalization shared by on-device distance evaluation and the
// runtime CSQL query builder. Stored case properties and search centers both
// accept CommCare's two-part `lat lon` and four-part
// `lat lon altitude accuracy` forms. HQ and JavaRosa both admit literal `NaN`
// for altitude/accuracy, while latitude/longitude must stay numeric.

// JavaRosa's `double()` accepts ordinary decimal spellings but not a leading
// plus sign or exponent notation. Latitude/longitude use that exact shared
// subset so static CSQL, Preview SQL, and on-device range checks agree.
export const GEOPOINT_NUMBER_PATTERN = String.raw`-?(?:[0-9]{1,32}(?:\.[0-9]{0,32})?|\.[0-9]{1,32})`;
const GEOPOINT_METADATA_NUMBER_PATTERN = String.raw`[+-]?(?:[0-9]{1,32}(?:\.[0-9]{0,32})?|\.[0-9]{1,32})(?:[eE][+-]?[0-9]{1,3})?`;
const GEOPOINT_METADATA_PATTERN = `(?:${GEOPOINT_METADATA_NUMBER_PATTERN}|NaN)`;
export const GEOPOINT_PROPERTY_PATTERN = `^${GEOPOINT_NUMBER_PATTERN} ${GEOPOINT_NUMBER_PATTERN}(?: ${GEOPOINT_METADATA_PATTERN} ${GEOPOINT_METADATA_PATTERN})?$`;
export const GEOPOINT_CENTER_PATTERN = `^${GEOPOINT_NUMBER_PATTERN} ${GEOPOINT_NUMBER_PATTERN}(?: ${GEOPOINT_METADATA_PATTERN} ${GEOPOINT_METADATA_PATTERN})?$`;
export const GEOPOINT_RAW_CENTER_PATTERN = `^(?:\\s*${GEOPOINT_NUMBER_PATTERN}\\s+${GEOPOINT_NUMBER_PATTERN}(?:\\s+${GEOPOINT_METADATA_PATTERN}\\s+${GEOPOINT_METADATA_PATTERN})?\\s*|\\s*${GEOPOINT_NUMBER_PATTERN}\\s*,\\s*${GEOPOINT_NUMBER_PATTERN}\\s*)$`;

/** Canonicalize commas and arbitrary whitespace using Core-registered calls. */
export function normalizeOnDeviceGeopoint(xpath: string): string {
	const commasToSpaces = `translate(${xpath}, ',', ' ')`;
	const trimmed = `replace(${commasToSpaces}, '^\\s+|\\s+$', '')`;
	return `replace(${trimmed}, '\\s+', ' ')`;
}

export function normalizeStaticGeopoint(value: string): string {
	return value.replaceAll(",", " ").trim().split(/\s+/).join(" ");
}

const centerRegex = new RegExp(GEOPOINT_CENTER_PATTERN);
const rawCenterRegex = new RegExp(
	GEOPOINT_RAW_CENTER_PATTERN.replaceAll("\\s", "[ \\t\\n\\x0B\\f\\r]"),
);

/** HQ's flexible search-center contract after Nova's input normalization. */
export function isValidStaticGeopointCenter(value: string): boolean {
	if (!rawCenterRegex.test(value)) return false;
	const normalized = normalizeStaticGeopoint(value);
	if (!centerRegex.test(normalized)) return false;
	const [latitude, longitude] = normalized.split(" ").map(Number);
	return (
		Number.isFinite(latitude) &&
		latitude >= -90 &&
		latitude <= 90 &&
		Number.isFinite(longitude) &&
		longitude >= -180 &&
		longitude <= 180
	);
}

/**
 * Runtime validity guard for a center already canonicalized by
 * `normalizeOnDeviceGeopoint`. Boolean `and` short-circuits on JavaRosa, so
 * component extraction never reaches malformed nonempty text.
 */
export function validOnDeviceGeopointCenter(
	rawXpath: string,
	normalizedXpath = normalizeOnDeviceGeopoint(rawXpath),
): string {
	return [
		`regex(${rawXpath}, '${GEOPOINT_RAW_CENTER_PATTERN}')`,
		`regex(${normalizedXpath}, '${GEOPOINT_CENTER_PATTERN}')`,
		`double(selected-at(${normalizedXpath}, 0)) >= -90`,
		`double(selected-at(${normalizedXpath}, 0)) <= 90`,
		`double(selected-at(${normalizedXpath}, 1)) >= -180`,
		`double(selected-at(${normalizedXpath}, 1)) <= 180`,
	].join(" and ");
}

/** Search inputs whose bytes contribute to a runtime geopoint center. */
export function collectRuntimeGeopointInputNames(
	predicate: Predicate,
): ReadonlySet<string> {
	const names = new Set<string>();
	walkPredicateNodes(predicate, (node) => {
		if (node.kind !== "within-distance") return;
		for (const name of collectGeopointCenterInputNames(node.center)) {
			names.add(name);
		}
	});
	return names;
}

/**
 * Search prompts whose values can flow into one computed geopoint center.
 * Predicate selectors (`if.cond`, `switch.on`, `count.where`) decide which
 * output is used but do not themselves become location text, so they are not
 * blamed with a location-format error.
 */
export function collectGeopointCenterInputNames(
	expression: ValueExpression,
): ReadonlySet<string> {
	const names = new Set<string>();

	const visit = (value: ValueExpression): void => {
		switch (value.kind) {
			case "term":
				if (value.term.kind === "input") names.add(value.term.name);
				return;
			case "today":
			case "now":
			case "id-of":
			case "acting-user":
			case "unowned":
				return;
			case "date-coerce":
			case "datetime-coerce":
			case "double":
			case "unwrap-list":
				visit(value.value);
				return;
			case "format-date":
				visit(value.date);
				return;
			case "date-add":
				visit(value.date);
				visit(value.quantity);
				return;
			case "arith":
				visit(value.left);
				visit(value.right);
				return;
			case "concat":
				for (const part of value.parts) visit(part);
				return;
			case "coalesce":
				for (const candidate of value.values) visit(candidate);
				return;
			case "if":
				visit(value.then);
				visit(value.else);
				return;
			case "switch":
				for (const entry of value.cases) visit(entry.then);
				visit(value.fallback);
				return;
			case "count":
				return;
			default: {
				const _exhaustive: never = value;
				throw new Error(
					`collectGeopointCenterInputNames: unhandled expression ${String(_exhaustive)}`,
				);
			}
		}
	};

	visit(expression);
	return names;
}
