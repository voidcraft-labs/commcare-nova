import {
	GEOPOINT_CENTER_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/commcare/predicate/geopoint";
import { xpathToString } from "./coerce";
import { javaRosaRegex, javaRosaReplace } from "./javaPatternRuntime";
import type { XPathFunctionInvocation, XPathValue } from "./types";

const CASE_SCALAR_BOUNDARY_PATTERN = "^[\\x00-\\x20]+|[\\x00-\\x20]+$";

/**
 * Execute only the Java Pattern expressions Nova generates itself and has
 * verified against CommCare Core. These synchronous carrier expressions are
 * bounded machine output; user-authored Pattern evaluation stays in the XPath
 * worker so backtracking cannot freeze the builder's main thread.
 */
export function invokeGeneratedJavaRosaFunction(
	name: string,
	args: readonly XPathValue[],
): XPathFunctionInvocation {
	if (name !== "regex" && name !== "replace") {
		return { kind: "unsupported" };
	}
	const pattern = xpathToString(args[1] ?? "");
	if (!isGeneratedPattern(pattern)) return { kind: "unsupported" };

	const value = xpathToString(args[0] ?? "");
	if (name === "regex") {
		return { kind: "handled", value: javaRosaRegex(value, pattern) };
	}
	const replacement = xpathToString(args[2] ?? "");
	return {
		kind: "handled",
		value: javaRosaReplace(value, pattern, replacement),
	};
}

function isGeneratedPattern(pattern: string): boolean {
	switch (pattern) {
		case GEOPOINT_RAW_CENTER_PATTERN:
		case GEOPOINT_CENTER_PATTERN:
		case "^\\s+|\\s+$":
		case "\\s+":
		case CASE_SCALAR_BOUNDARY_PATTERN:
		case "[ \\t\\r\\n]+":
		case "^ | $":
			return true;
		default:
			return false;
	}
}
