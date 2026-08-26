import {
	createJavaPatternFunctions,
	type JavaPatternEngine,
} from "./javaPatternBoundary";
import {
	find,
	pow,
	replaceAllLiteral,
} from "./vendor/javaPatternRuntime.generated.js";

/**
 * TeaVM compiles pinned OpenJDK 17 Pattern, Matcher, and fdlibm sources into
 * this worker-safe static ESM boundary. Never replace the regex operations
 * with JavaScript RegExp: its grammar and replacement rules are observably
 * different from Java Pattern.
 */
const javaPatternEngine: JavaPatternEngine = {
	find(pattern, input) {
		try {
			return find(input, pattern);
		} catch {
			// XPath source can contain private app data. Do not forward TeaVM's
			// exception because PatternSyntaxException includes the pattern text.
			throw new Error("The regular expression is invalid.");
		}
	},
	replaceAllLiteral(pattern, input, replacement) {
		try {
			return replaceAllLiteral(input, pattern, replacement);
		} catch {
			throw new Error("The regular expression is invalid.");
		}
	},
};

const javaPatternFunctions = createJavaPatternFunctions(javaPatternEngine);

export const javaRosaRegex = javaPatternFunctions.regex;
export const javaRosaReplace = javaPatternFunctions.replace;

/** OpenJDK 17 fdlibm result for JavaRosa's `Math.pow` XPath function. */
export const javaRosaPow = pow;
