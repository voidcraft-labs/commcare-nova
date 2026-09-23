import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { standardCaseReadsFixture } from "../../../lib/commcare/__tests__/standardCaseReadsFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";

const output = process.argv[2];
if (!output)
	throw new Error("Usage: emit-standard-case-reads.ts OUTPUT_DIRECTORY");
const doc = standardCaseReadsFixture();
const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
if (findings.length) throw new Error(JSON.stringify(findings));
const bytes = compileCcz(expandDoc(doc), doc.appName, doc);
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "standard-case-reads.ccz"), bytes);
writeFileSync(
	resolve(output, "standard-case-reads.xml"),
	new AdmZip(bytes).readAsText("modules-0/forms-0.xml"),
);
