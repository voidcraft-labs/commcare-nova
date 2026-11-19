/**
 * Contract: a case list key that CommCare HQ's pages store at HQ's default names no value class
 * the default is not of. The claim log records a claim at a default that takes the value whole
 * under an allowing entry, so the lane counts that entry as shown by the base; a stage that
 * claimed a column's empty graph under the entry of a graph on another column, or a callout's
 * switch left off under the entry of a switch off beside stale keys, would count an entry no
 * base holds. Each case stores the keys HQ's Case List page writes
 * (`details/bootstrap5/column.js::serialize`, the detail's own save) beside the one change that
 * makes the class.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { patients, uuid } from "./fixtures";
import {
	closedCodes,
	type Detail,
	readLists as readListsOf,
} from "./listReading";

const M = "menus-and-case-lists/";

const readLists = namingFromHqPages(readListsOf);

/** HQ's default for a column's graph (`models/case_list.py::DetailColumn.graph_configuration`). */
const EMPTY_GRAPH = {
	annotations: [],
	config: {},
	doc_type: "GraphConfiguration",
	locale_specific_config: {},
	series: [],
};

/** A callout's keys as a detail's save stores them with the callout off, every one at HQ's
 *  default (`models/case_list.py::Detail`). */
const CALLOUT_OFF = {
	lookup_enabled: false,
	lookup_autolaunch: false,
	lookup_image: null,
	lookup_extras: [],
	lookup_responses: [],
	lookup_display_results: false,
	lookup_field_header: {},
};

/** The place, the entry and the surface key of each record the reading makes under `entries`
 *  on the list's screen; the detail's columns keep what Nova's export writes there. */
async function recordsUnder(
	entries: readonly string[],
	edit: (short: Detail, long: Detail) => void,
) {
	const reading = await readLists(
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes"),
		]),
		{
			edit: (app) => {
				const pair = app.modules[0]?.case_details;
				if (pair !== undefined) edit(pair.short, pair.long);
			},
		},
	);
	expect(closedCodes(reading)).toEqual([]);
	return [...reading.ctx.close().claims.records()]
		.filter((one) => entries.includes(one.entry))
		.map((one) => [
			one.where.replace(/^.*\/case_details\//, ""),
			one.entry,
			one.key,
		])
		.filter(([where]) => where?.startsWith("short/"));
}

const GRAPH_OTHER = `${M}graph-configuration-non-empty-on-any-other-column`;
const GRAPH_NULL = `${M}graph-configuration-null`;
const LOOKUP_OFF = `${M}lookup-enabled-false-with-stale-keys`;

describe("a case list key at HQ's default", () => {
	it("leaves a column's empty graph to no graph entry", async () => {
		const records = await recordsUnder([GRAPH_OTHER, GRAPH_NULL], (short) => {
			for (const column of short.columns)
				column.graph_configuration = EMPTY_GRAPH;
		});
		expect(records).toEqual([]);
	});

	it("claims a graph on another column, and a null one, each under its own class", async () => {
		const records = await recordsUnder([GRAPH_OTHER, GRAPH_NULL], (short) => {
			const [first, second] = short.columns;
			if (first !== undefined)
				first.graph_configuration = { ...EMPTY_GRAPH, graph_type: "xy" };
			if (second !== undefined) second.graph_configuration = null;
		});
		// The graph's own key that holds a value other than its default is recorded where that
		// value sits, under the column's entry, which names it (`jsonCursor.ts::within`): the
		// lane reads a use of it there.
		expect(records).toEqual([
			[
				"short/columns/0/graph_configuration",
				GRAPH_OTHER,
				"schema:DetailColumn.graph_configuration",
			],
			[
				"short/columns/0/graph_configuration/graph_type",
				GRAPH_OTHER,
				"schema:GraphConfiguration.graph_type",
			],
			[
				"short/columns/1/graph_configuration",
				GRAPH_NULL,
				"schema:DetailColumn.graph_configuration",
			],
		]);
	});

	it("leaves a callout switched off with every key at HQ's default to no entry", async () => {
		const records = await recordsUnder([LOOKUP_OFF], (short, long) => {
			Object.assign(short, CALLOUT_OFF);
			Object.assign(long, CALLOUT_OFF);
		});
		expect(records).toEqual([]);
	});

	it("claims a key a switched-off callout left behind, with the switch, under the stale keys' class", async () => {
		const records = await recordsUnder([LOOKUP_OFF], (short) => {
			Object.assign(short, CALLOUT_OFF, { lookup_name: "Scan" });
		});
		// The switch stands at HQ's default, so its record names no surface key.
		expect(records).toEqual([
			["short/lookup_enabled", LOOKUP_OFF, null],
			["short/lookup_name", LOOKUP_OFF, "schema:Detail.lookup_name"],
		]);
	});
});
