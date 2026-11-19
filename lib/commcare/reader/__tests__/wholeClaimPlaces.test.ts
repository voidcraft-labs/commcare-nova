/**
 * Where a claim that takes a value whole stands inside it
 * (`jsonCursor.ts::within`, `accounting.ts::within`): at each key of each of
 * HQ's objects in the value that holds a value other than its class's
 * default, under the claim's entry where that entry names the key, so the
 * claim's record stands where each value it reads sits, as the lane's parity
 * looks for it; and a whole object read past under a key above it stands at
 * that key.
 *
 * It would catch a container claimed whole that records only its own key
 * (each key inside left with no record), a key inside recorded under an entry
 * that does not name it, a key at its class's default recorded (no use), and
 * a language the app does not hold recorded at its own key while its entry
 * names the translations' key.
 */

import { describe, expect, it } from "vitest";
import { inventoryIndex } from "../../surface/inventory";
import { Accounting } from "../accounting";
import { account, defineClaims, drop } from "../claims";
import { appPlace } from "../place";

const A = "application-and-settings";
const M = "menus-and-case-lists";

const CLAIMS = defineClaims("wholeClaimPlacesTest", {
	buildSpec: account(
		`${A}/34-hq-build-spec-at-or-above-nova-s-floor-2-57`,
		"schema:Application.build_spec",
	),
	refDetails: account(`${M}/module-ref-details`, "schema:Module.ref_details"),
	unreadLanguage: account(
		`${A}/translations-key-no-runtime-reads`,
		"schema:Application.translations",
	),
	translations: drop(
		`${A}/translations-key-no-runtime-reads`,
		"schema:Application.translations",
	),
});

function records(ledger: Accounting) {
	return [...ledger.close().claims.records()].map(({ where, key, entry }) => ({
		where,
		key,
		entry,
	}));
}

describe("a claim that takes a value whole", () => {
	it("stands at each key inside it its entry names, and at no key at its default", () => {
		const ledger = new Accounting(inventoryIndex(), { log: "full" });
		const app = ledger.json(
			{
				build_spec: {
					version: "2.57.0",
					build_number: null,
					latest: true,
					doc_type: "BuildSpec",
				},
			},
			appPlace(),
		);
		app.account("build_spec", CLAIMS.buildSpec);
		const entry = CLAIMS.buildSpec.entry;
		expect(records(ledger)).toEqual([
			{ where: "/build_spec", key: "schema:Application.build_spec", entry },
			{ where: "/build_spec/latest", key: "schema:BuildSpec.latest", entry },
			{ where: "/build_spec/version", key: "schema:BuildSpec.version", entry },
		]);
	});

	it("stands at an undeclared key inside a value it reads past, under the class's undeclared-key item", () => {
		const ledger = new Accounting(inventoryIndex(), { log: "full" });
		const module = ledger.json(
			{
				ref_details: {
					doc_type: "DetailPair",
					short: {
						doc_type: "Detail",
						display: "short",
						custom_variables: "<x/>",
					},
				},
			},
			appPlace(),
		);
		module.account("ref_details", CLAIMS.refDetails);
		const entry = CLAIMS.refDetails.entry;
		expect(records(ledger)).toEqual([
			{ where: "/ref_details", key: "schema:Module.ref_details", entry },
			{ where: "/ref_details/short", key: "schema:DetailPair.short", entry },
			{
				where: "/ref_details/short/custom_variables",
				key: "schema:Detail.<undeclared>",
				entry,
			},
			{
				where: "/ref_details/short/display",
				key: "schema:Detail.display",
				entry,
			},
		]);
	});
});

describe("a whole object read past under a key above it", () => {
	it("stands at that key, where the value its entry names sits", () => {
		const ledger = new Accounting(inventoryIndex(), { log: "full" });
		const app = ledger.json({ translations: { fra: { a: "b" } } }, appPlace());
		const languages = app.map(
			"translations",
			"Application.translations",
			CLAIMS.translations,
		);
		languages.get("fra")?.refuseWhole(CLAIMS.unreadLanguage);
		const entry = CLAIMS.unreadLanguage.entry;
		expect(records(ledger)).toEqual([
			{ where: "/translations", key: "schema:Application.translations", entry },
			{ where: "/translations", key: "schema:Application.translations", entry },
		]);
	});
});
