import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXPECTED_RUNTIME_SHA256 =
	"5511bf0684cf102ed7bae4e5723b3791a494ed33327efc7c0f52f7dbef03c3af";
const EXPECTED_NAMES_SHA256 =
	"89541422e4cfce6efd42b470ea76ff03734c330e4c92301223ca555811eb4691";

const artifact = fileURLToPath(
	new URL(
		"../../lib/preview/xpath/vendor/javaPatternRuntime.generated.js",
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
const doubleStringSourcePath = fileURLToPath(
	new URL("../../lib/preview/xpath/openJdk17DoubleString.ts", import.meta.url),
);
const [source, namesSource, doubleStringSource] = await Promise.all([
	readFile(artifact, "utf8"),
	readFile(namesArtifact, "utf8"),
	readFile(doubleStringSourcePath, "utf8"),
]);
for (const filename of await readdir(openJdkSourceDirectory)) {
	if (!filename.endsWith(".java")) continue;
	const javaSource = await readFile(
		`${openJdkSourceDirectory}/${filename}`,
		"utf8",
	);
	if (!javaSource.includes("Copyright (c)")) continue;
	if (!/Modified by Dimagi, Inc\. on \d{4}-\d{2}-\d{2}/.test(javaSource)) {
		throw new Error(`OpenJDK modification notice is missing from ${filename}.`);
	}
}
if (
	!/Modified by Dimagi, Inc\. on \d{4}-\d{2}-\d{2}/.test(doubleStringSource)
) {
	throw new Error("OpenJDK FloatingDecimal modification notice is missing.");
}
if (
	/\beval\s*\(|\bnew\s+Function\s*\(/.test(
		source + namesSource + doubleStringSource,
	)
) {
	throw new Error("Java Pattern runtime violates Nova's CSP boundary.");
}
if (
	!/export\{[^}]*\bas find\b[^}]*\bas replaceAllLiteral\b[^}]*\}/.test(source)
) {
	throw new Error("Java Pattern runtime exports are missing.");
}
const bytes = Buffer.byteLength(source);
if (bytes > 275_000) {
	throw new Error(
		`Java Pattern runtime exceeds the 275 KB source cap: ${bytes}`,
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
const digest = createHash("sha256").update(source).digest("hex");
if (digest !== EXPECTED_RUNTIME_SHA256) {
	throw new Error(
		`Java Pattern runtime is not the reviewed reproducible artifact: ${digest}`,
	);
}
const namesDigest = createHash("sha256").update(namesSource).digest("hex");
if (namesDigest !== EXPECTED_NAMES_SHA256) {
	throw new Error(
		`OpenJDK 17 character-name table is not the reviewed artifact: ${namesDigest}`,
	);
}
console.log(
	`java-pattern-runtime sha256=${digest} bytes=${bytes} names_sha256=${namesDigest} names_bytes=${namesBytes}`,
);
