import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXPECTED_PATTERN_SHA256 =
	"5511bf0684cf102ed7bae4e5723b3791a494ed33327efc7c0f52f7dbef03c3af";
const EXPECTED_MATH_SHA256 =
	"58e6587531bbb815d8c6712e8e8fd9c17da83caed2d46cd546da0f40d5392d1c";
const EXPECTED_NAMES_SHA256 =
	"89541422e4cfce6efd42b470ea76ff03734c330e4c92301223ca555811eb4691";

const patternArtifact = fileURLToPath(
	new URL(
		"../../lib/preview/xpath/vendor/javaPatternRuntime.generated.js",
		import.meta.url,
	),
);
const mathArtifact = fileURLToPath(
	new URL(
		"../../lib/preview/xpath/vendor/javaMathRuntime.generated.js",
		import.meta.url,
	),
);
const namesArtifact = fileURLToPath(
	new URL(
		"../../lib/preview/xpath/vendor/javaPatternNames.generated.ts",
		import.meta.url,
	),
);
const openJdkSourceDirectory = fileURLToPath(
	new URL(
		"./src/main/java/org/commcare/nova/xpath/openjdkregex/",
		import.meta.url,
	),
);
const openJdkMathSourceDirectory = fileURLToPath(
	new URL(
		"./src/main/java/org/commcare/nova/xpath/openjdkmath/",
		import.meta.url,
	),
);
const doubleStringSourcePath = fileURLToPath(
	new URL("../../lib/preview/xpath/openJdk17DoubleString.ts", import.meta.url),
);
const [patternSource, mathSource, namesSource, doubleStringSource] =
	await Promise.all([
		readFile(patternArtifact, "utf8"),
		readFile(mathArtifact, "utf8"),
		readFile(namesArtifact, "utf8"),
		readFile(doubleStringSourcePath, "utf8"),
	]);
for (const directory of [openJdkSourceDirectory, openJdkMathSourceDirectory]) {
	for (const filename of await readdir(directory)) {
		if (!filename.endsWith(".java")) continue;
		const javaSource = await readFile(`${directory}/${filename}`, "utf8");
		if (!javaSource.includes("Copyright (c)")) continue;
		if (!/Modified by Dimagi, Inc\. on \d{4}-\d{2}-\d{2}/.test(javaSource)) {
			throw new Error(
				`OpenJDK modification notice is missing from ${filename}.`,
			);
		}
	}
}
if (
	!/Modified by Dimagi, Inc\. on \d{4}-\d{2}-\d{2}/.test(doubleStringSource)
) {
	throw new Error("OpenJDK FloatingDecimal modification notice is missing.");
}
if (
	/\beval\s*\(|\bnew\s+Function\s*\(/.test(
		patternSource + mathSource + namesSource + doubleStringSource,
	)
) {
	throw new Error("Java compatibility runtime violates Nova's CSP boundary.");
}
if (
	!["find", "replaceAllLiteral"].every((name) =>
		new RegExp(`\\bas ${name}\\b`).test(patternSource),
	) ||
	!/\bas pow\b/.test(mathSource)
) {
	throw new Error("Java compatibility runtime entry exports are missing.");
}
const patternBytes = Buffer.byteLength(patternSource);
if (patternBytes > 270_000) {
	throw new Error(
		`Java Pattern runtime exceeds the 270 KB source cap: ${patternBytes}`,
	);
}
const mathBytes = Buffer.byteLength(mathSource);
if (mathBytes > 20_000) {
	throw new Error(
		`Java fdlibm runtime exceeds the 20 KB source cap: ${mathBytes}`,
	);
}
if (!/export function openJdk17CodePointOf\(/.test(namesSource)) {
	throw new Error("OpenJDK 17 character-name lookup export is missing.");
}
const namesBytes = Buffer.byteLength(namesSource);
if (namesBytes > 500_000) {
	throw new Error(
		`OpenJDK 17 character-name table exceeds the 500 KB source cap: ${namesBytes}`,
	);
}
const patternDigest = createHash("sha256").update(patternSource).digest("hex");
if (patternDigest !== EXPECTED_PATTERN_SHA256) {
	throw new Error(
		`Java Pattern runtime is not the reviewed reproducible artifact: ${patternDigest}`,
	);
}
const mathDigest = createHash("sha256").update(mathSource).digest("hex");
if (mathDigest !== EXPECTED_MATH_SHA256) {
	throw new Error(
		`Java fdlibm runtime is not the reviewed reproducible artifact: ${mathDigest}`,
	);
}
const namesDigest = createHash("sha256").update(namesSource).digest("hex");
if (namesDigest !== EXPECTED_NAMES_SHA256) {
	throw new Error(
		`OpenJDK 17 character-name table is not the reviewed artifact: ${namesDigest}`,
	);
}
console.log(
	`java-pattern-runtime pattern_sha256=${patternDigest} pattern_bytes=${patternBytes} math_sha256=${mathDigest} math_bytes=${mathBytes} names_sha256=${namesDigest} names_bytes=${namesBytes}`,
);
