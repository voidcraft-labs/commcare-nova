import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	csqlScenarios,
	scenarioRecord,
} from "../../../lib/commcare/__tests__/csqlCompositionFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import {
	CSQL_READER_VECTORS,
	csqlRow,
	csqlVectorDoc,
	rowContext,
	rowEnv,
} from "../../../lib/commcare/reader/expressions/__tests__/csqlVectors";
import { readSearchFilterRow } from "../../../lib/commcare/reader/expressions/csqlRead";
import { inventoryIndex } from "../../../lib/commcare/surface/inventory";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --conditions=react-server --import tsx proof/native/producers/emit-csql-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
const runtimeTarget = {
	server: "production",
	domain: "nova-search-evidence",
	appId: "search-evidence",
} as const;
const records: string[] = [];
for (const scenario of csqlScenarios) {
	const doc = scenario.doc();
	const hq = expandDoc(doc, { runtimeTarget });
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc, { runtimeTarget }));
	writeFileSync(resolve(output, `${scenario.id}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario.id}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario.id}.strings.txt`),
		zip.readAsText("default/app_strings.txt"),
	);
	records.push(JSON.stringify(scenarioRecord(scenario)));
}
// One line per scenario: its cases, searches and expected ids. Not `.json`,
// which the family's HQ step reads as app sources.
writeFileSync(resolve(output, "scenarios.jsonl"), `${records.join("\n")}\n`);

// The search row reader's reading of each CSQL text the reader is held to, for
// test_csql_reader_parity.py, which reads the same texts with HQ's own CSQL
// parser and filter builder. One line per text, as `scenarios.jsonl`: every
// `.json` in this directory is an app source to the family's HQ step.
const readerDoc = csqlVectorDoc();
const readerContext = rowContext(readerDoc);
const readerEnv = rowEnv(readerDoc);
const index = inventoryIndex();
const vectors = CSQL_READER_VECTORS.map((vector) => {
	const reading = readSearchFilterRow(
		csqlRow(vector.csql),
		readerContext,
		readerEnv,
	);
	const verdict = reading.ok
		? { held: reading.level }
		: "claim" in reading
			? {
					entry: reading.claim.entryId,
					disposition: index.entry(reading.claim.entryId)?.disposition,
				}
			: { unrecognized: true };
	return JSON.stringify({ id: vector.id, csql: vector.csql, verdict });
});
writeFileSync(resolve(output, "csql-reader.jsonl"), `${vectors.join("\n")}\n`);
