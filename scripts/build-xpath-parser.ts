/**
 * Builds the Lezer parser from the CommCare XPath grammar file.
 * Run: npx tsx scripts/build-xpath-parser.ts
 * Output: lib/codemirror/xpath-parser.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { buildParserFile } from "@lezer/generator";

const grammarPath = join(__dirname, "..", "lib", "codemirror", "xpath.grammar");
const outputPath = join(
	__dirname,
	"..",
	"lib",
	"codemirror",
	"xpath-parser.ts",
);

const grammar = readFileSync(grammarPath, "utf-8");

const { parser, terms } = buildParserFile(grammar, {
	fileName: "xpath.grammar",
	moduleStyle: "es",
	typeScript: true,
});

writeFileSync(outputPath, parser);
console.log("Parser written to", outputPath);

// Also write terms file for reference
const termsPath = join(
	__dirname,
	"..",
	"lib",
	"codemirror",
	"xpath-parser.terms.ts",
);
writeFileSync(termsPath, terms);
console.log("Terms written to", termsPath);
