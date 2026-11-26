import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { readForLane } from "@/proof/reader/laneReading";

it("dumps hq-languages localization", async () => {
	const reading = await readForLane(laneInputOf(retainedBase("hq-languages")));
	appendFileSync(
		"/private/tmp/claude-501/-Users-braxtonperry-work-personal-code-commcare-nova/f6427b1b-df73-4bfe-8c38-91ea397b1eae/scratchpad/lang.log",
		JSON.stringify(
			reading.kind === "read"
				? { name: reading.doc.appName, loc: reading.doc.localization }
				: reading,
			null,
			1,
		),
	);
}, 180_000);
