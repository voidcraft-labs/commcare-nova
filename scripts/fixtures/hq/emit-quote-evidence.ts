import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { csqlQuoteFixture } from "../../../lib/commcare/__tests__/csqlQuoteFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-quote-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
const doc = csqlQuoteFixture();
const runtimeTarget = {
	server: "production",
	domain: "nova-search-evidence",
	appId: "search-evidence",
} as const;
const hq = expandDoc(doc, { runtimeTarget });
const zip = new AdmZip(compileCcz(hq, doc.appName, doc, { runtimeTarget }));
writeFileSync(resolve(output, "runtime-quotes.json"), JSON.stringify(hq));
writeFileSync(
	resolve(output, "runtime-quotes.suite.xml"),
	zip.readAsText("suite.xml"),
);
writeFileSync(
	resolve(output, "runtime-quotes.strings.txt"),
	zip.readAsText("default/app_strings.txt"),
);
