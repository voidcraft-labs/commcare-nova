import { describe, expect, it } from "vitest";
import {
	GEOPOINT_CENTER_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/commcare/predicate/geopoint";
import { invokeGeneratedJavaRosaFunction } from "../generatedJavaRosaFunctions";
import { javaRosaRegex, javaRosaReplace } from "../javaPatternRuntime";

const GENERATED_PATTERNS = [
	GEOPOINT_RAW_CENTER_PATTERN,
	GEOPOINT_CENTER_PATTERN,
	"^\\s+|\\s+$",
	"\\s+",
	"^[\\x00-\\x20]+|[\\x00-\\x20]+$",
	"[ \\t\\r\\n]+",
	"^ | $",
] as const;

const VALUES = [
	"",
	"plain",
	" ",
	"  padded  ",
	"\tline\nfeed\r",
	"\u0000control\u001f",
	"\u00a0unicode-space\u00a0",
	"42 -71",
	" 42, -71 ",
	"42 -71 12 3",
	"-90 180 NaN 3e2",
	"91 181",
	"$1 $& \\tail",
] as const;

describe("generated JavaRosa functions", () => {
	it("matches the pinned OpenJDK runtime for every machine-owned pattern", () => {
		for (const pattern of GENERATED_PATTERNS) {
			for (const value of VALUES) {
				const result = invokeGeneratedJavaRosaFunction("regex", [
					value,
					pattern,
				]);
				expect(result).toEqual({
					kind: "handled",
					value: javaRosaRegex(value, pattern),
				});
			}
		}
	});

	it("keeps OpenJDK replacement matching and literal replacement semantics", () => {
		for (const pattern of GENERATED_PATTERNS) {
			for (const value of VALUES) {
				for (const replacement of ["", "_", "$1$&\\tail"]) {
					const result = invokeGeneratedJavaRosaFunction("replace", [
						value,
						pattern,
						replacement,
					]);
					expect(result).toEqual({
						kind: "handled",
						value: javaRosaReplace(value, pattern, replacement),
					});
				}
			}
		}
	});

	it("refuses arbitrary authored patterns", () => {
		expect(
			invokeGeneratedJavaRosaFunction("regex", ["private", "[a-z]+"]),
		).toEqual({ kind: "unsupported" });
	});
});
