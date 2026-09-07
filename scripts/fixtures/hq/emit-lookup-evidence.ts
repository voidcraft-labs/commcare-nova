import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { lookupAppFixture } from "../../../lib/commcare/__tests__/lookupAppFixtures";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import {
	lookupWireCorpus,
	wireRow,
	wireTable,
} from "../../../lib/commcare/lookup/__tests__/lookupWireCorpus";
import { nativeLookupRelations } from "../../../lib/commcare/lookup/__tests__/nativeLookupRelations";
import { buildLookupFixtures } from "../../../lib/commcare/lookup/fixtures";
import { hqWouldTrimLookupText } from "../../../lib/commcare/lookup/hqCellText";
import { lookupWireNaming } from "../../../lib/commcare/lookup/naming";
import { buildLookupWorkbook } from "../../../lib/commcare/lookup/workbook";

const output = resolve(process.argv[2] ?? "/tmp/nova-lookup-evidence");
mkdirSync(output, { recursive: true });
const corpus = lookupWireCorpus();
const naming = lookupWireNaming(corpus.definitions);
const workbook = buildLookupWorkbook(naming, corpus.rowsByTable);
writeFileSync(resolve(output, "lookup.xlsx"), workbook.bytes);
for (const fixture of buildLookupFixtures(naming, corpus.rowsByTable).fixtures)
	writeFileSync(resolve(output, `${fixture.tag}.xml`), fixture.xml);
const manyColumns = wireTable(
	"columns",
	Array.from({ length: 50 }, (_, index) => ({
		name: `c${index}`,
		type: "text",
	})),
);
const manyRow = wireRow(
	manyColumns,
	"r",
	Object.fromEntries(
		Array.from({ length: 50 }, (_, index) => [`c${index}`, `v${index}`]),
	),
);
writeFileSync(
	resolve(output, "columns.xlsx"),
	buildLookupWorkbook(
		lookupWireNaming([manyColumns]),
		new Map([[manyColumns.id, [manyRow]]]),
	).bytes,
);
const counterexample = wireTable("padding", [{ name: "value", type: "text" }]);
const stripCharacters = Array.from(
	{ length: 0x110000 },
	(_, point) => point,
).filter((point) => hqWouldTrimLookupText(String.fromCodePoint(point)));
const padded = [
	"  padded \t",
	"\u00a0choice\u00a0",
	"\ufeffvalue\ufeff",
	...stripCharacters
		.filter((point) => point >= 0x20 || [9, 10, 13].includes(point))
		.map(
			(point) =>
				`${String.fromCodePoint(point)}value${String.fromCodePoint(point)}`,
		),
].map((value, index) => wireRow(counterexample, String(index), { value }));
writeFileSync(
	resolve(output, "padding.xlsx"),
	buildLookupWorkbook(
		lookupWireNaming([counterexample]),
		new Map([[counterexample.id, padded]]),
	).bytes,
);
writeFileSync(
	resolve(output, "expected.json"),
	JSON.stringify(
		{
			tables: corpus.expected,
			totalWorkbookRows: workbook.totalWorkbookRows,
			stripCharacters,
			padding: padded.map((row) => Object.values(row.values)[0]),
			sourceHashes: Object.fromEntries(
				[
					"lib/commcare/lookup/__tests__/lookupWireCorpus.ts",
					"lib/commcare/lookup/__tests__/nativeLookupRelations.ts",
					"lib/commcare/__tests__/lookupAppFixtures.ts",
					"lib/commcare/expression/onDeviceEmitter.ts",
					"lib/commcare/predicate/termEmitter.ts",
					"scripts/fixtures/javarosa/LookupRuntimeTest.java",
					"lib/commcare/lookup/workbook.ts",
					"lib/commcare/lookup/textWorkbook.ts",
					"lib/commcare/serializeXml.ts",
					"lib/commcare/lookup/fixtures.ts",
					"lib/commcare/lookup/cellText.ts",
					"lib/commcare/lookup/hqCellText.ts",
					"lib/commcare/lookup/naming.ts",
					"lib/lookup/coercion.ts",
					"scripts/fixtures/hq/emit-lookup-evidence.ts",
				].map((path) => [
					path,
					createHash("sha256")
						.update(readFileSync(resolve(path)))
						.digest("hex"),
				]),
			),
		},
		null,
		2,
	),
);
console.log(output);

for (const reversed of [false, true]) {
	const { doc, naming, fixtures } = lookupAppFixture(reversed);
	const hq = expandDoc(doc, { lookupNaming: naming });
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { lookup: { naming, fixtures } }),
	);
	const name = reversed ? "lookup-reversed" : "lookup-app";
	writeFileSync(resolve(output, `${name}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${name}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${name}.xml`),
		zip.readAsText("modules-0/forms-0.xml"),
	);
}

writeFileSync(
	resolve(output, "lookup-relations.tsv"),
	nativeLookupRelations(lookupAppFixture().naming)
		.map(({ name, expression }) => `${name}\t${expression}`)
		.join("\n"),
);
