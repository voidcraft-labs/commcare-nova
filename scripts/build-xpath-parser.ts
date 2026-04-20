/**
 * Builds the Lezer parser from the CommCare XPath grammar file.
 * Run: npx tsx scripts/build-xpath-parser.ts
 * Output: lib/commcare/xpath/parser.ts (+ parser.terms.ts)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildParserFile } from "@lezer/generator";

// The grammar source + generated parser live inside the CommCare boundary
// (lib/commcare/xpath/) because CommCare's XPath dialect is what the grammar
// describes. CodeMirror editor extensions consume it via the barrel, not the
// other way around.
const xpathDir = join(__dirname, "..", "lib", "commcare", "xpath");
const grammarPath = join(xpathDir, "grammar.lezer.grammar");
const outputPath = join(xpathDir, "parser.ts");
const termsPath = join(xpathDir, "parser.terms.ts");

const grammar = readFileSync(grammarPath, "utf-8");

const { parser, terms } = buildParserFile(grammar, {
	fileName: "grammar.lezer.grammar",
	moduleStyle: "es",
	typeScript: true,
});

writeFileSync(outputPath, parser);
console.log("Parser written to", outputPath);

writeFileSync(termsPath, terms);
console.log("Terms written to", termsPath);
