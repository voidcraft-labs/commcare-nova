import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	promptLookupContext,
	promptLookupFixtures,
	promptLookupNaming,
	promptScenarios,
	searchPromptFixture,
} from "../../../lib/commcare/__tests__/searchPromptFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { buildLookupFixtures } from "../../../lib/commcare/lookup/fixtures";
import { lookupRowIdSchema } from "../../../lib/domain/lookupIds";

/**
 * Labels of the regions table's group `C`, in row order: an order by UTF-16
 * code unit (`10`, `9`, `B`, `Z`, `a`, `a`, `a`, `b`, `é`) differs from any
 * locale's, and three rows tie. `SearchPromptRuntimeTest` reads the order
 * Core lists them in, on both paths, from the `<sort>` each itemset holds.
 */
const ORDER_LABELS = ["b", "B", "a", "é", "Z", "a", "10", "9", "a"];

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-prompt-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of promptScenarios) {
	const doc = searchPromptFixture(scenario);
	const runtimeTarget = {
		server: "production",
		domain: "nova-search-evidence",
		appId: "search-evidence",
	} as const;
	const hq = expandDoc(doc, {
		runtimeTarget,
		lookupNaming: promptLookupNaming,
	});
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget,
			lookup: { naming: promptLookupNaming, fixtures: promptLookupFixtures },
		}),
	);
	writeFileSync(resolve(output, `${scenario}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario}.strings.txt`),
		zip.readAsText("default/app_strings.txt"),
	);
}
writeFileSync(
	resolve(output, "regions.fixture.xml"),
	promptLookupFixtures.fixtures[0].xml,
);
if (promptLookupContext.kind !== "available")
	throw new Error("The prompt fixture's lookup context holds its tables.");
const [regions] = promptLookupContext.definitions;
const [code, label, group] = regions?.columns ?? [];
if (regions === undefined || !code || !label || !group)
	throw new Error(
		"The prompt fixture's regions table names its three columns.",
	);
writeFileSync(
	resolve(output, "regions-order.fixture.xml"),
	buildLookupFixtures(
		promptLookupNaming,
		new Map([
			[
				regions.id,
				ORDER_LABELS.map((text, index) => ({
					id: lookupRowIdSchema.parse(
						`018f0000-0000-7000-8000-0000000002${String(index).padStart(2, "0")}`,
					),
					values: {
						[code.id]: `row_${index}`,
						[label.id]: text,
						[group.id]: "C",
					},
				})),
			],
		]),
	).fixtures[0].xml,
);
