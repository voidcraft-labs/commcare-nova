import { describe, expect, it } from "vitest";
import {
	javaRosaPow,
	javaRosaRegex,
	javaRosaReplace,
} from "../javaPatternRuntime";

describe("Java compatibility runtime", () => {
	it("pins OpenJDK 17 fdlibm power results instead of host JavaScript math", () => {
		expect(javaRosaPow(10, 23)).toBe(1e23);
		expect(javaRosaPow(2, -1074)).toBe(Number.MIN_VALUE);
		expect(javaRosaPow(-2, 3)).toBe(-8);
		expect(javaRosaPow(-2, 0.5)).toBeNaN();
	});

	it("passes CommCare Core's frozen regex fixtures", () => {
		const fixtures: readonly [string, string, boolean][] = [
			["12345", "[0-9]+", true],
			["aaaabfooaaabgarplyaaabwackyb", "a*b", true],
			["photo", "a*b", false],
			["Is this right?", "is", true],
			["Is this right?", "^is", false],
			["Is this right?", "^Is this right?$", false],
			["Is this right?", String.raw`^Is this right\?$`, true],
			["Dollar sign\ndoes not match newlines", "sign$", false],
			["Dollar sign\ndoes not match newlines", "newlines$", true],
			["cocotero", "cocotero", true],
			["cocotero", "te", true],
		];
		for (const [input, pattern, expected] of fixtures) {
			expect(javaRosaRegex(input, pattern)).toBe(expected);
		}
	});

	it("passes CommCare Core's frozen replacement fixtures", () => {
		expect(javaRosaReplace("aaaabfooaaabgarplyaaabwackyb", "a*b", "-")).toBe(
			"-foo-garply-wacky-",
		);
		expect(javaRosaReplace("abbc", "a(.*)c", "$1")).toBe("$1");
		expect(javaRosaReplace("aaabb", "[ab][ab][ab]", "")).toBe("bb");
	});

	it("uses Core's Matcher.find semantics", () => {
		expect(javaRosaRegex("cocotero", "te")).toBe(true);
		expect(javaRosaRegex("cocotero", "^te$")).toBe(false);
		expect(javaRosaRegex("Line one\nLINE TWO", "(?im)^line two$")).toBe(true);
	});

	it("supports Java-only character classes and backtracking constructs", () => {
		expect(javaRosaRegex("aei-bcdf-xyz", "[a-z&&[^aeiou]]{4}")).toBe(true);
		expect(javaRosaRegex("aa", "a++a")).toBe(false);
		expect(javaRosaRegex("aa", "(?>a*)a")).toBe(false);
		expect(javaRosaRegex("xxaaabaaa", "(a+)b\\1")).toBe(true);
		expect(javaRosaRegex("foobar", "(?<=foo)bar")).toBe(true);
	});

	it("replaces every match with a quoted literal replacement", () => {
		expect(javaRosaReplace("a1 b22", "\\d+", "$1\\tail")).toBe(
			"a$1\\tail b$1\\tail",
		);
		expect(javaRosaReplace("cocotero", "o", "x")).toBe("cxcxterx");
	});

	it("redacts invalid patterns at the Java boundary", () => {
		const privatePattern = "[private-app-value";
		expect(() => javaRosaRegex("input", privatePattern)).toThrow(
			"The regular expression is invalid.",
		);
		try {
			javaRosaRegex("input", privatePattern);
		} catch (error) {
			expect(String(error)).not.toContain(privatePattern);
		}
	});

	it("matches Formplayer's OpenJDK 17 regex contract", () => {
		expect(javaRosaRegex("line\nbreak", "\\R")).toBe(true);
		expect(javaRosaRegex("space\ttab", "\\h")).toBe(true);
		expect(javaRosaRegex("a\u0301", "^\\X$")).toBe(true);
		expect(javaRosaRegex("👩‍💻", "^\\X$")).toBe(true);
		expect(javaRosaRegex("aa", String.raw`(?<letter>a)\k<letter>`)).toBe(true);
		expect(javaRosaRegex("é", "(?U)^\\w+$")).toBe(true);
		expect(javaRosaRegex("é", "^\\w+$")).toBe(false);
		expect(javaRosaRegex("Ω", "^\\p{sc=Grek}$")).toBe(true);
		expect(javaRosaRegex("A", "^\\p{InBasic_Latin}$")).toBe(true);
		expect(javaRosaRegex("e\u0301", "(?c)[é]")).toBe(true);
		// CANON_EQ is scoped: a literal outside the group remains decomposed.
		expect(javaRosaRegex("e\u0301e\u0301", "(?c:[é])e\u0301")).toBe(true);
		// Nag Mundari was added after Unicode 13, which is the JDK 17 table.
		expect(javaRosaRegex("\u{1e4d0}", "^\\p{L}$")).toBe(false);
	});
});
