/**
 * A case list filter HQ's page stored with one of HQ's shortcuts reads as
 * the typed read Nova prints for it. HQ's build interpolates the filter into
 * the list's nodeset (`entries.py::EntriesHelper.get_filter_xpath`,
 * `interpolate_xpath` with `current()` as the case), so `#user/district` and
 * Nova's print of the worker's record are one filter on the device. The
 * plausible failure: the list's own round trip compares the stored shortcut
 * with Nova's print as text and stops the reading at the filter.
 */
import { expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { readForLane } from "@/proof/reader/laneReading";

it("reads a list filter stored as #user/<field> as the worker's record", async () => {
	const input = laneInputOf(retainedBase("hq-case-management"));
	const source = JSON.parse(input.source.body ?? "{}");
	source.modules[1].case_details.short.filter = "#user/district";
	const reading = await readForLane({
		...input,
		source: { ...input.source, body: JSON.stringify(source) },
	});
	if (reading.kind !== "read")
		throw new Error(JSON.stringify(reading.findings));
	const members = reading.doc.modules[reading.doc.moduleOrder[1] ?? ""];
	expect(members?.caseListConfig?.filter).toMatchObject({
		kind: "term",
		term: { kind: "session-user-property", source: "worker-record" },
	});
}, 120_000);
