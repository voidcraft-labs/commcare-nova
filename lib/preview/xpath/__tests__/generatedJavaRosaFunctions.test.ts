import { describe, expect, it } from "vitest";
import { CSQL_LIST_ITEM_UNSAFE_PATTERN } from "@/lib/commcare/csql/segment";
import { CONNECT_RECIPIENT_PATTERN } from "@/lib/domain/connectRecipientRule";
import {
	GEOPOINT_CENTER_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/domain/expression/geopoint";
import { invokeGeneratedJavaRosaFunction } from "../generatedJavaRosaFunctions";
import { javaRosaRegex, javaRosaReplace } from "../javaPatternRuntime";

const GENERATED_PATTERNS = [
	CONNECT_RECIPIENT_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
	GEOPOINT_CENTER_PATTERN,
	"^\\s+|\\s+$",
	"\\s+",
	"^[\\x00-\\x20]+|[\\x00-\\x20]+$",
	"[ \\t\\r\\n]+",
	"^ | $",
	CSQL_LIST_ITEM_UNSAFE_PATTERN,
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
	'say "hi"',
	"back\\slash",
	"delete\u007f",
	"it's",
	"p{Cntrl}",
] as const;

describe("generated JavaRosa functions", () => {
	it("matches the compiled OpenJDK runtime across a finite generated-pattern corpus", () => {
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

	it("counts the complete recipient ID in Unicode code points including newlines", () => {
		for (const value of [
			"🪶".repeat(255),
			"🪶".repeat(255) + "\n",
			"🪶".repeat(254) + "\n",
			"界".repeat(256),
		]) {
			const accepted = Array.from(value).length <= 255;
			expect(javaRosaRegex(value, CONNECT_RECIPIENT_PATTERN)).toBe(accepted);
			expect(
				invokeGeneratedJavaRosaFunction("regex", [
					value,
					CONNECT_RECIPIENT_PATTERN,
				]),
			).toEqual({ kind: "handled", value: accepted });
		}
	});

	it("refuses arbitrary authored patterns", () => {
		expect(
			invokeGeneratedJavaRosaFunction("regex", ["private", "[a-z]+"]),
		).toEqual({ kind: "unsupported" });
	});
});
