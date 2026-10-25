/**
 * The date-and-time split's witness: a date-and-time question asked as a
 * date question and a time question, joined by a Hidden Value that keeps the
 * original's identity, case write and every reader.
 *
 * The original is the shared one (`lib/doc/__tests__/datetimeSplitFixture.ts`),
 * with Nova's own planner's splits applied (`lib/doc/datetimeSplit.ts::planDatetimeSplits`):
 * "Check" splits the writer `seen_at`, which starts from the case, may not be
 * later than now, and saves `visit.seen_at`; "Plan" splits two non-writers,
 * `planned_at` and `due_at`, read by a label, a constraint, a relevance that
 * compares the two joins, and a Hidden Value making the same comparison.
 *
 * The joined value is the clock-keeping date, which Nova binds
 * `xsd:dateTime` (bind rule R3), so Core holds it as `DateTimeData` with its
 * clock, as it held the question's answer. Every expectation answers the two
 * questions with a wall clock and reads the join back in the same zone, so
 * the device's zone does not enter. A typed date and time is read through
 * `coalesce`, which unpacks the node: Core's `format-date` of a node rounds
 * its `Date` to the day (`FunctionUtils.java::toDate`). The comparison is the
 * Hidden Value `order`, which holds Nova's lowering of the same comparison
 * the note's relevance makes, by instant.
 *
 * The split's fields run on both platforms, so the document declares
 * nothing and every reader reads it.
 */

import { produce } from "immer";
import {
	datetimeSplitNames,
	datetimeSplitOriginal,
} from "@/lib/doc/__tests__/datetimeSplitFixture";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { applyMutations } from "@/lib/doc/mutations";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

const ID = "targeted-datetime-split";
const uuid = (name: string) => targetedUuid(ID, name);

export function datetimeSplit() {
	const original = datetimeSplitOriginal({ uuid, appId: ID });
	const plan = planDatetimeSplits(original);
	if (!plan.ok)
		throw new Error(
			`Nova's planner refused to split ${ID}'s questions: ${plan.message}`,
		);
	const doc = produce(original, (draft) => {
		applyMutations(draft, plan.mutations);
	});
	const names = datetimeSplitNames(uuid);
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-visit",
				type: "visit",
				name: "Amina",
				properties: { seen_at: "2026-03-01T08:00:00.000Z" },
			},
		],
	});
	const plannedAt = (time: string) => [
		{ path: "/data/planned_at_date", value: "2026-03-04" },
		{ path: "/data/planned_at_time", value: time },
	];
	const dueAt = (time: string) => [
		{ path: "/data/due_at_date", value: "2026-03-04" },
		{ path: "/data/due_at_time", value: time },
	];
	const compare = (id: string, due: string, value: string): Expectation => ({
		id,
		export: "local",
		form: names.plan,
		request: {
			answers: [...plannedAt("09:15:00"), ...dueAt(due)],
			expressions: ["/data/order"],
		},
		expect: [{ pointer: "/values/0/value", value }],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"the date-and-time split: a writer with its preload, validation and default, and non-writers read by a constraint, a label and a comparison of two joins",
		],
		doc,
		expected: {
			intent: [
				{
					id: "split-writer-joins",
					export: "local",
					form: names.check,
					restore: "restore.xml",
					request: {
						session: {
							command: "m0-f1",
							data: { case_id: "targeted-visit" },
						},
						answers: [
							{ path: "/data/seen_at_date", value: "2026-03-04" },
							{ path: "/data/seen_at_time", value: "10:30:00" },
						],
						expressions: [
							"format-date(coalesce(/data/seen_at, ''), '%Y-%m-%d %H:%M')",
						],
						// After the answer, so the time question's validation, which
						// reads the join against now(), passes; the lane's default
						// clock is 2026-01-15.
						clock: "2026-03-05T12:00:00.000Z",
					},
					expect: [
						{ pointer: "/answers/0/result", value: "ok" },
						{ pointer: "/answers/1/result", value: "ok" },
						{ pointer: "/values/0/value", value: "2026-03-04 10:30" },
					],
				},
				{
					id: "split-reader-joins",
					export: "local",
					form: names.plan,
					request: {
						answers: plannedAt("09:15:00"),
						expressions: [
							"format-date(coalesce(/data/planned_at, ''), '%H:%M')",
						],
					},
					expect: [{ pointer: "/values/0/value", value: "09:15" }],
				},
				compare("split-joins-compare-later", "10:00:00", "due later"),
				compare("split-joins-compare-earlier", "09:00:00", "due earlier"),
			],
		},
		files: { "restore.xml": restore },
	});
}
