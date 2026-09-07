import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { csqlStaticQuoteFixture } from "../../../lib/commcare/__tests__/csqlStaticQuoteFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-static-quote-evidence.ts OUTPUT_DIRECTORY",
	);
const doc = csqlStaticQuoteFixture("safe");
const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
if (findings.length) throw new Error(JSON.stringify(findings));
const runtimeTarget = {
	server: "production",
	domain: "nova-search-evidence",
	appId: "search-evidence",
} as const;
const hq = expandDoc(doc, { runtimeTarget });
const zip = new AdmZip(compileCcz(hq, doc.appName, doc, { runtimeTarget }));
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "static-quotes.json"), JSON.stringify(hq));
writeFileSync(
	resolve(output, "static-quotes.suite.xml"),
	zip.readAsText("suite.xml"),
);
