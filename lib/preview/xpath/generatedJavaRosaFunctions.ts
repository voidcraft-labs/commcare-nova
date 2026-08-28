import {
	GEOPOINT_CENTER_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/commcare/predicate/geopoint";
import { xpathToString } from "./coerce";
import type { XPathFunctionInvocation, XPathValue } from "./types";

const CASE_SCALAR_BOUNDARY_PATTERN = "^[\\x00-\\x20]+|[\\x00-\\x20]+$";
const JAVA_ASCII_WHITESPACE = "[ \\t\\n\\x0B\\f\\r]";

/**
 * Nova emits only these fixed Pattern sources into synchronous preview
 * carriers. Compile their Java-compatible subset once instead of loading the
 * complete OpenJDK Pattern implementation onto the Builder's main thread.
 * User-authored patterns still execute in that exact runtime inside the XPath
 * worker; this table is deliberately closed over machine-owned strings.
 */
const GENERATED_PATTERNS = new Map<
	string,
	{ readonly find: RegExp; readonly replace: RegExp }
>(
	[
		GEOPOINT_RAW_CENTER_PATTERN,
		GEOPOINT_CENTER_PATTERN,
		"^\\s+|\\s+$",
		"\\s+",
		CASE_SCALAR_BOUNDARY_PATTERN,
		"[ \\t\\r\\n]+",
		"^ | $",
	].map((pattern) => {
		/* Java Pattern's default `\\s` is the six-character ASCII class. JS
		 * `\\s` also consumes Unicode spaces, so preserve Core's smaller set. */
		const source = pattern.replaceAll("\\s", JAVA_ASCII_WHITESPACE);
		return [
			pattern,
			{ find: new RegExp(source), replace: new RegExp(source, "g") },
		];
	}),
);

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
	const generated = GENERATED_PATTERNS.get(pattern);
	if (generated === undefined) return { kind: "unsupported" };

	const value = xpathToString(args[0] ?? "");
	if (name === "regex") {
		return { kind: "handled", value: generated.find.test(value) };
	}
	const replacement = xpathToString(args[2] ?? "");
	return {
		kind: "handled",
		/* A callback makes `$1`, `$&`, and backslashes literal, matching
		 * `Matcher.quoteReplacement` at the OpenJDK boundary. */
		value: value.replace(generated.replace, () => replacement),
	};
}
