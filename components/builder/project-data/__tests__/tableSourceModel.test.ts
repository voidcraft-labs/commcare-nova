/**
 * The two table-source confirmations' state: what each shows follows from
 * the answers it took for what the person chose, whatever order the
 * server's answers arrive in.
 */
import { describe, expect, it } from "vitest";
import {
	appsStillListed,
	TAKE_HQ_TABLE_UNCHOSEN,
	type TableSourceReview,
	type TakeHqTableEvent,
	type TakeHqTableState,
	takeHqTablePending,
	takeHqTableReducer,
	takeHqTableWorking,
} from "../tableSourceModel";

const CHOOSE =
	"You can choose the project space whose table Nova uses for this one.";
const reviewOf = (domain: string): TableSourceReview => ({
	title: `Use the table in ${domain} for Districts?`,
	lines: [`${domain} holds 3 rows.`],
	reviewDigest: `digest-${domain}`,
});
const run = (...events: TakeHqTableEvent[]): TakeHqTableState =>
	events.reduce(takeHqTableReducer, TAKE_HQ_TABLE_UNCHOSEN);

describe("Use the table from CommCare HQ", () => {
	it("invites a choice, and reads no table, until a project space is chosen", () => {
		expect(takeHqTableWorking(TAKE_HQ_TABLE_UNCHOSEN)).toBe(false);
		expect(takeHqTablePending(TAKE_HQ_TABLE_UNCHOSEN, CHOOSE)).toBe(CHOOSE);
	});

	it("says it is reading only while the chosen project space's read is in flight", () => {
		const reading = run({ kind: "choose", key: "north" });
		expect(takeHqTableWorking(reading)).toBe(true);
		expect(takeHqTablePending(reading, CHOOSE)).toBe("Reading the table");
		const read = takeHqTableReducer(reading, {
			kind: "read",
			key: "north",
			review: reviewOf("north"),
			refusal: null,
		});
		expect(takeHqTableWorking(read)).toBe(false);
		expect(read.review).toEqual(reviewOf("north"));
	});

	it("keeps the review of the project space now chosen where an earlier choice's answer lands after it", () => {
		const state = run(
			{ kind: "choose", key: "north" },
			{ kind: "choose", key: "south" },
			{ kind: "read", key: "south", review: reviewOf("south"), refusal: null },
			{ kind: "read", key: "north", review: reviewOf("north"), refusal: null },
		);
		expect(state).toMatchObject({ chosen: "south", review: reviewOf("south") });
		expect(takeHqTableWorking(state)).toBe(false);
	});

	it("stays reading the project space now chosen where an earlier choice's answer lands first", () => {
		const state = run(
			{ kind: "choose", key: "north" },
			{ kind: "choose", key: "south" },
			{ kind: "read", key: "north", review: null, refusal: "North refused." },
		);
		expect(state).toMatchObject({
			chosen: "south",
			review: null,
			refusal: null,
		});
		expect(takeHqTableWorking(state)).toBe(true);
	});

	it("shows a refusal of the confirmation with the review read again", () => {
		const state = run(
			{ kind: "choose", key: "north" },
			{ kind: "read", key: "north", review: reviewOf("north"), refusal: null },
			{ kind: "confirm" },
			{
				kind: "confirmed",
				key: "north",
				refusal: "Something changed.",
				review: { ...reviewOf("north"), reviewDigest: "moved" },
			},
		);
		expect(state).toMatchObject({
			confirming: false,
			refusal: "Something changed.",
			review: { reviewDigest: "moved" },
		});
	});
});

describe("Create a separate table", () => {
	it("drops an app the review read again no longer lists, keeping the rest in order", () => {
		expect(
			appsStillListed(["b", "a", "c"], [{ appId: "a" }, { appId: "c" }]),
		).toEqual(["a", "c"]);
	});
});
