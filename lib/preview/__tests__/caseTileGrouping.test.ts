// The cards of a grouped tile list, made from the rows that remain. The
// vectors are worked from commcare-core `util/screen/EntityScreenHelper.java::
// groupEntities` (each key's place is its first appearance among the rows
// given, and a group's members keep their order) and HQ's Web Apps client
// `menus/views.js::CaseTileGroupedListView.initialize` (one model a group, the
// first, which draws the heading and takes the tap). The proof lane holds the
// same rule on CommCare's own code (`targeted-tile-group-filter`).

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { groupedPageRows, tileGroupCards } from "../caseTileGrouping";

interface Visit {
	readonly case_id: string;
	readonly household: string;
}

const visit = (case_id: string, household: string): Visit => ({
	case_id,
	household,
});
const ADA = visit("ada", "K");
const BEN = visit("ben", "R");
const CAL = visit("cal", "K");
const DOT = visit("dot", "R");
const EVE = visit("eve", "");
const byHousehold = (row: Visit) => row.household;

const cardsOf = (rows: readonly Visit[]) =>
	tileGroupCards(rows, byHousehold).map((card) => ({
		key: card.key,
		rows: card.rows.map((row) => row.case_id),
	}));

describe("tileGroupCards", () => {
	it("gathers every row of the list into its group, in order of first appearance", () => {
		expect(cardsOf([ADA, BEN, CAL, DOT, EVE])).toEqual([
			{ key: "K", rows: ["ada", "cal"] },
			{ key: "R", rows: ["ben", "dot"] },
			{ key: "", rows: ["eve"] },
		]);
	});

	it("orders the cards by each one's first match, and heads each with that match", () => {
		const cards = tileGroupCards([BEN, CAL, DOT], byHousehold);
		// A card order kept from the unfiltered list would put K first.
		expect(cards.map((card) => card.key)).toEqual(["R", "K"]);
		// A heading or a choice kept from the group's own first case would be Ada.
		expect(cards[1].rows[0]).toBe(CAL);
		expect(cardsOf([BEN, CAL, DOT])).toEqual([
			{ key: "R", rows: ["ben", "dot"] },
			{ key: "K", rows: ["cal"] },
		]);
	});

	it("treats the empty key as a key like any other", () => {
		expect(cardsOf([EVE, ADA])).toEqual([
			{ key: "", rows: ["eve"] },
			{ key: "K", rows: ["ada"] },
		]);
	});

	it("makes no cards of no rows", () => {
		expect(tileGroupCards([], byHousehold)).toEqual([]);
	});
});

describe("groupedPageRows", () => {
	const page = {
		groups: [
			{ key: "K", rows: [ADA, CAL] },
			{ key: "R", rows: [BEN, DOT] },
		],
		listOrder: ["ada", "ben", "cal", "dot"],
	};

	it("puts the page back in the list's order, each row knowing its own group", () => {
		const { rows, keyOf } = groupedPageRows(page);
		expect(rows).toEqual([ADA, BEN, CAL, DOT]);
		expect(rows.map(keyOf)).toEqual(["K", "R", "K", "R"]);
	});

	it("puts a row the list's order does not name last, in its clustered order", () => {
		const { rows } = groupedPageRows({
			groups: [
				{ key: "", rows: [EVE] },
				{ key: "K", rows: [ADA, CAL] },
			],
			listOrder: ["cal", "ada"],
		});
		expect(rows).toEqual([CAL, ADA, EVE]);
	});
});

/** Rows with distinct ids in list order, each with a key from a small set so groups repeat. */
const listRows = fc
	.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 30 })
	.chain((ids) =>
		fc.tuple(
			fc.constant(ids),
			fc.array(fc.constantFrom("", "K", "R", "S"), {
				minLength: ids.length,
				maxLength: ids.length,
			}),
			fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
		),
	)
	.map(([ids, keys, kept]) => ({
		rows: ids.map((id, index) => visit(id, keys[index])),
		kept,
	}));

/** The clustering the case store's grouped read gives: groups by first appearance, members in order. */
function firstAppearanceClusters(rows: readonly Visit[]) {
	const keys: string[] = [];
	for (const row of rows)
		if (!keys.includes(row.household)) keys.push(row.household);
	return keys.map((key) => ({
		key,
		rows: rows.filter((row) => row.household === key),
	}));
}

describe("tileGroupCards over any rows and any filter", () => {
	it("puts every kept row in exactly one card, keeps list order, and orders cards by their first row", async () => {
		await fc.assert(
			fc.property(listRows, ({ rows, kept }) => {
				const matches = rows.filter((_, index) => kept[index]);
				const cards = tileGroupCards(matches, byHousehold);
				const carded = cards.flatMap((card) => card.rows);
				expect([...carded].sort(byId)).toEqual([...matches].sort(byId));
				expect(new Set(cards.map((card) => card.key)).size).toBe(cards.length);
				const place = (row: Visit) => matches.indexOf(row);
				for (const card of cards) {
					for (const row of card.rows) expect(row.household).toBe(card.key);
					const places = card.rows.map(place);
					expect(places).toEqual([...places].sort((a, b) => a - b));
				}
				const firsts = cards.map((card) => place(card.rows[0]));
				expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
			}),
		);
	});

	it("gives, with every row kept, the groups the case store's clustering gives", async () => {
		await fc.assert(
			fc.property(listRows, ({ rows }) => {
				const cards = tileGroupCards(rows, byHousehold).map((card) => ({
					key: card.key,
					rows: [...card.rows],
				}));
				expect(cards).toEqual(firstAppearanceClusters(rows));
			}),
		);
	});

	it("reads a clustered page back as the list it came from", async () => {
		await fc.assert(
			fc.property(listRows, ({ rows }) => {
				const { rows: back, keyOf } = groupedPageRows({
					groups: firstAppearanceClusters(rows),
					listOrder: rows.map((row) => row.case_id),
				});
				expect(back).toEqual(rows);
				expect(back.map(keyOf)).toEqual(rows.map(byHousehold));
			}),
		);
	});
});

function byId(a: Visit, b: Visit): number {
	return a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0;
}
