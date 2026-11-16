import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	promptLookupContext,
	promptLookupFixtures,
	promptLookupNaming,
	promptLookupRows,
	promptScenarios,
	searchPromptFixture,
	searchPromptWorkerPlaceFixture,
	WORKER_PLACE_SEARCH_MENUS,
} from "../../../lib/commcare/__tests__/searchPromptFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { buildLookupFixtures } from "../../../lib/commcare/lookup/fixtures";
import type { BlueprintDoc } from "../../../lib/domain";
import { lookupRowIdSchema } from "../../../lib/domain/lookupIds";
import { readPreviewScreen } from "../../../lib/preview/engine/dataRefusal";
import type { PreviewSearchSessionValues } from "../../../lib/preview/engine/identity";
import { previewLookupData } from "../../../lib/preview/engine/lookupEvaluation";
import { openSearchRunState } from "../../../lib/preview/engine/searchRunState";

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
function emit(scenario: string, doc: BlueprintDoc): void {
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
for (const scenario of promptScenarios)
	emit(scenario, searchPromptFixture(scenario));
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

/**
 * The worker-place Search document (`searchPromptWorkerPlaceFixture`), and
 * `prompt-worker-place.openings.jsonl`: for a worker assigned nowhere and a
 * worker placed at `north`, whether Preview stops each menu's Search screen
 * as it opens, and the starting answers of each field where it opens.
 * Preview's reading is what the screen reads as it opens, its run state
 * (`searchRunState.ts::openSearchRunState`, which `useSearchInputRunState`,
 * App Tests and the form check read), each choice list among its reads, on
 * either platform. `SearchPromptRuntimeTest` holds Core's query manager to
 * it: built for each menu's search, it fails exactly where Preview stops, for
 * the reason Preview gives (`refusal`: the worker's place, or a one-field
 * screen's starting choice its list does not offer), and otherwise holds the
 * answers Preview opens with, a starting choice the list does not offer let
 * go on a screen of several fields.
 */
const PLACE_WORKERS: readonly Readonly<Record<string, string>>[] = [
	{},
	{
		commcare_location_id: "north",
		commcare_location_ids: "north",
		commcare_primary_case_sharing_id: "north",
	},
];
const placeDoc = searchPromptWorkerPlaceFixture();
emit("prompt-worker-place", placeDoc);
const placeLookup = previewLookupData({
	projectRevision: "1",
	definitions: promptLookupContext.definitions,
	rowsByTable: promptLookupRows,
});
const openings = PLACE_WORKERS.map((user) => {
	const session: PreviewSearchSessionValues = {
		context: { userid: "worker-id", username: "worker" },
		user,
		userPropertySlugs: {},
	};
	return {
		user,
		menus: placeDoc.moduleOrder.map((moduleUuid, index) => {
			const inputs = placeDoc.modules[moduleUuid]?.caseListConfig?.searchInputs;
			if (inputs === undefined)
				throw new Error("Each worker-place menu has a Search.");
			const environment = {
				doc: placeDoc,
				moduleUuid,
				lookup: placeLookup,
				sessionData: {},
			};
			const read = readPreviewScreen(() =>
				openSearchRunState(moduleUuid, inputs, session, environment),
			);
			return {
				menu: WORKER_PLACE_SEARCH_MENUS[index],
				command: `search_command.m${index}`,
				refused: read.kind === "refused",
				/* Why: a worker field the device lacks, or a one-field screen's
				 * starting choice its list does not offer. */
				refusal: read.kind === "refused" ? read.refusal.reason.kind : null,
				fields: inputs
					.filter((input) => input.kind !== "hidden")
					.map((input) => input.name),
				answers:
					read.kind === "read" ? Object.fromEntries(read.value.defaults) : {},
			};
		}),
	};
});
/* A witness whose readings never differ reads nothing: some menu must stop
 * for one worker and open for the other, and some menu must open for both. */
const verdicts = WORKER_PLACE_SEARCH_MENUS.map((_, index) =>
	openings.map((opening) => opening.menus[index]?.refused),
);
if (!verdicts.some((menu) => menu.includes(true) && menu.includes(false)))
	throw new Error(
		"No worker-place Search menu stops for one worker and opens for the other; give the workers one assigned nowhere and one placed.",
	);
if (!verdicts.some((menu) => menu.every((refused) => refused === false)))
	throw new Error("Every worker-place Search menu stops for some worker.");
/* One line per worker and menu, under a name the HQ step's `*.json` import
 * glob leaves alone. */
writeFileSync(
	resolve(output, "prompt-worker-place.openings.jsonl"),
	openings
		.flatMap(({ user, menus }) =>
			menus.map((menu) => JSON.stringify({ user, ...menu })),
		)
		.join("\n"),
);
