import {
	GEOPOINT_CENTER_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/commcare/predicate/geopoint";
import { xpathToString } from "./coerce";
import type { XPathFunctionInvocation, XPathValue } from "./types";

const ASCII_WHITESPACE = "[ \\t\\n\\x0B\\f\\r]";
const CASE_SCALAR_BOUNDARY_PATTERN = "^[\\x00-\\x20]+|[\\x00-\\x20]+$";

/**
 * Execute only the Java Pattern expressions Nova generates itself and has
 * verified against CommCare Core. This is intentionally not a Java-regex
 * approximation: arbitrary `regex()` / `replace()` remain unsupported in the
 * user-authored Preview carrier because Java Pattern and ECMAScript RegExp do
 * not define the same language.
 */
export function invokeGeneratedJavaRosaFunction(
	name: string,
	args: readonly XPathValue[],
): XPathFunctionInvocation {
	if (name !== "regex" && name !== "replace") {
		return { kind: "unsupported" };
	}
	const pattern = xpathToString(args[1] ?? "");
	const compiled = compileGeneratedPattern(pattern);
	if (compiled === undefined) return { kind: "unsupported" };

	const value = xpathToString(args[0] ?? "");
	if (name === "regex") {
		return { kind: "handled", value: compiled.test(value) };
	}
	const replacement = xpathToString(args[2] ?? "");
	return {
		kind: "handled",
		// Core quotes the replacement with Matcher.quoteReplacement. A callback
		// gives JavaScript the same literal-replacement behavior for `$` bytes.
		value: value.replace(compiled, () => replacement),
	};
}

function compileGeneratedPattern(pattern: string): RegExp | undefined {
	switch (pattern) {
		case GEOPOINT_RAW_CENTER_PATTERN:
			return new RegExp(pattern.replaceAll("\\s", ASCII_WHITESPACE), "g");
		case GEOPOINT_CENTER_PATTERN:
			return new RegExp(pattern, "g");
		case "^\\s+|\\s+$":
			return new RegExp(`^${ASCII_WHITESPACE}+|${ASCII_WHITESPACE}+$`, "g");
		case "\\s+":
			return new RegExp(`${ASCII_WHITESPACE}+`, "g");
		case CASE_SCALAR_BOUNDARY_PATTERN:
			return new RegExp(CASE_SCALAR_BOUNDARY_PATTERN, "g");
		case "[ \\t\\r\\n]+":
			return /[ \t\r\n]+/g;
		case "^ | $":
			return /^ | $/g;
		default:
			return undefined;
	}
}
