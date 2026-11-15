import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	WORKER_PLACE_OWNER_FORM,
	workerPlaceOwnerFixture,
	workerSlugs,
	workerWireFixture,
} from "../../../lib/commcare/__tests__/workerWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import type { BlueprintDoc } from "../../../lib/domain";
import { previewDataRefusalOf } from "../../../lib/preview/engine/dataRefusal";
import { buildEngineInput } from "../../../lib/preview/engine/engineInput";
import { FormEngine } from "../../../lib/preview/engine/formEngine";
import type { ResolvedPreviewIdentity } from "../../../lib/preview/engine/identity";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-worker-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
function emit(name: string, doc: BlueprintDoc): void {
	const hq = expandDoc(doc),
		zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: NATIVE_RUNTIME_TARGET,
			}),
		);
	writeFileSync(resolve(output, `worker-${name}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `worker-${name}.xml`),
		zip.readAsText("modules-0/forms-0.xml"),
	);
	writeFileSync(
		resolve(output, `worker-${name}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
}
for (const slug of workerSlugs) emit(slug, workerWireFixture(slug).doc);

/**
 * The worker-place owner document (`workerPlaceOwnerFixture`), and
 * `worker-place-owner.refusals.jsonl`: for a worker assigned nowhere and one
 * placed in the group `group-north`, whether Preview refuses the form as it
 * opens. Preview's reading is its form engine's opening
 * (`FormEngine`'s constructor, which refuses where
 * `dataRefusal.ts::caseBlocksReadAbsentWorkerKey` finds a case block reading
 * a field the worker's session lacks), for a worker whose session holds
 * exactly that worker data. `WorkerIdentityRuntimeTest` holds Core's form
 * entry to it.
 */
const placeOwner = workerPlaceOwnerFixture();
emit("place-owner", placeOwner);
const PLACE_WORKERS: readonly Readonly<Record<string, string>>[] = [
	{},
	{
		commcare_location_id: "place-north",
		commcare_location_ids: "place-north",
		commcare_primary_case_sharing_id: "group-north",
	},
];
const input = buildEngineInput(placeOwner, WORKER_PLACE_OWNER_FORM, null);
if (input === undefined)
	throw new Error("The worker-place owner document has its form.");
const refusals = PLACE_WORKERS.map((user) => {
	/* The worker as Preview resolves one: the session's user data is exactly
	 * what HQ's restore would write for that worker. */
	const identity: ResolvedPreviewIdentity = {
		actorUserId: "worker",
		ownerId: "worker",
		session: {
			context: { userid: "worker", username: "worker" },
			user,
			userPropertySlugs: {},
		},
		usercase: {},
	};
	let refused = false;
	try {
		new FormEngine(input, "patient", undefined, identity, null, {
			rows: [],
			indices: [],
		});
	} catch (error) {
		if (previewDataRefusalOf(error) === undefined) throw error;
		refused = true;
	}
	return { user, refused };
});
if (!refusals.some(({ refused }) => refused))
	throw new Error(
		"Preview opens the worker-place owner form for every worker.",
	);
if (refusals.every(({ refused }) => refused))
	throw new Error(
		"Preview refuses the worker-place owner form for every worker.",
	);
/* One line per worker, under a name the HQ step's `worker-*.json` import
 * glob leaves alone. */
writeFileSync(
	resolve(output, "worker-place-owner.refusals.jsonl"),
	refusals.map((reading) => JSON.stringify(reading)).join("\n"),
);
