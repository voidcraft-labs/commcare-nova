import {
	createJavaPatternFunctions,
	type JavaPatternEngine,
} from "./javaPatternBoundary";
import {
	find,
	replaceAllLiteral,
} from "./vendor/javaPatternRuntime.generated.js";

/**
 * TeaVM compiles pinned OpenJDK 17 Pattern and Matcher sources into this
 * worker-safe static ESM boundary. Never route user-authored regex operations
 * through JavaScript RegExp: its grammar and replacement rules are observably
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
