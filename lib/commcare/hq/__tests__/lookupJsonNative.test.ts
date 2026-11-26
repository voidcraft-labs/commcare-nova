/**
 * The requests Nova's JSON carrier sends for one `types` table, held as the
 * native witness replays them through CommCare HQ's own resources
 * (`proof/hq/test_lookup_json.py`, over `proof/hq/fixtures/lookup-json-requests.json`).
 *
 * Contract: the fixture is exactly what `lookupJson.ts` sends for a table
 * the workbook cannot carry (its tag is `types`, a value keeps the spaces at
 * its ends, a row holds an empty occurrence with a property, an empty list
 * of occurrences, and a repeated field it does not hold), each row as
 * `jsonRows.ts::lookupJsonRowContent` makes it, and the fixture a worker is
 * served once the writes land is Nova's own fixture of the same rows
 * (`fixtures.ts::buildLookupFixtures`). The plausible failure: the witness
 * replaying requests Nova no longer sends, so HQ's verdict is over a stale
 * shape. Regenerate with `WRITE_LOOKUP_JSON_FIXTURE=1`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { wireTable, wireUuid } from "../../lookup/__tests__/lookupWireCorpus";
import { buildLookupFixtures } from "../../lookup/fixtures";
import {
	lookupJsonDefinition,
	lookupJsonRowContent,
} from "../../lookup/jsonRows";
import { lookupWireNaming } from "../../lookup/naming";
import { lookupRowJsonBody, lookupTableJsonBody } from "../lookupJson";

const FIXTURE = "proof/hq/fixtures/lookup-json-requests.json";
/** The table id each row body names, which the witness replaces with the id HQ gave the table. */
const TABLE_ID = "0000000000004000800000000000ab1e";

const NAME = lookupColumnIdSchema.parse(wireUuid("native-json-name"));
const ALIAS = lookupColumnIdSchema.parse(wireUuid("native-json-alias"));
const LANG = lookupMemberIdSchema.parse(wireUuid("native-json-lang"));
const CODE = lookupMemberIdSchema.parse(wireUuid("native-json-code"));

const definition: LookupTableDefinition = {
	...wireTable("types", [{ name: "name", type: "text" }]),
	id: lookupTableIdSchema.parse(wireUuid("native-json-types")),
	columns: [
		{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
		{
			id: ALIAS,
			wireName: "alias",
			label: "Alias",
			dataType: "text",
			repeated: true,
			properties: [{ id: LANG, wireName: "lang", label: "Language" }],
		},
	],
	attributes: [{ id: CODE, wireName: "code", label: "Code" }],
};
const naming = lookupWireNaming([definition]).tableFor(definition.id);

function row(
	key: string,
	partial: Partial<LookupFixtureRow>,
): LookupFixtureRow {
	return {
		id: lookupRowIdSchema.parse(wireUuid(`native-json-${key}`)),
		values: {},
		...partial,
	};
}

/** A clinic whose name and code keep their spaces, with an empty alias that holds a language. */
const clinic = row("clinic", {
	values: { [NAME]: "  Clinic  " },
	attributes: { [CODE]: " 007 " },
	occurrences: {
		[ALIAS]: [
			{ text: "", properties: { [LANG]: "en" } },
			{ text: "dispensaire", properties: {} },
		],
	},
});
/** A ward with an empty list of aliases. */
const ward = row("ward", {
	values: { [NAME]: "Ward" },
	attributes: { [CODE]: "2" },
	occurrences: { [ALIAS]: [] },
});
/** A hall that holds no alias at all. */
const hall = row("hall", {
	values: { [NAME]: "Hall" },
	attributes: { [CODE]: "3" },
});
const wardRenamed = { ...ward, values: { [NAME]: "Ward 2" } };

/** One row's body at `sortKey`, as the executor sends it. */
function body(fixtureRow: LookupFixtureRow, sortKey: number) {
	return lookupRowJsonBody(TABLE_ID, {
		...lookupJsonRowContent(naming, fixtureRow),
		sortKey,
	});
}

/**
 * The scenario the witness replays: the table created, the three rows
 * appended (CommCare HQ ranks them 0, 1, 2, whatever the body says), the
 * ward's name changed in place at its rank, the clinic moved after the
 * others by a PUT of its whole row, and the hall removed by its id. The
 * worker is then served the ward, then the clinic.
 */
function scenario() {
	const fixture = buildLookupFixtures(
		lookupWireNaming([definition]),
		new Map([[definition.id, [wardRenamed, clinic]]]),
	).fixtures[0];
	if (fixture === undefined) throw new Error("The table builds no fixture.");
	return {
		tableId: TABLE_ID,
		create: lookupTableJsonBody(lookupJsonDefinition(naming)),
		appends: [clinic, ward, hall].map((one, index) => body(one, index)),
		change: { row: 1, body: body(wardRenamed, 1) },
		move: { row: 0, body: body(clinic, 3) },
		remove: { row: 2 },
		served: fixture.xml,
	};
}

describe("the JSON carrier's requests the native witness replays", () => {
	it("are the ones lookupJson.ts sends, with the fixture Nova serves of the same rows", () => {
		const made = scenario();
		if (process.env.WRITE_LOOKUP_JSON_FIXTURE === "1")
			writeFileSync(FIXTURE, `${JSON.stringify(made, null, "\t")}\n`);
		expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(made);
	});
});
