/**
 * The claims the expression stage returns beside each slot's own: the uses
 * an expression's text makes, held or not, before HQ's interpolation, each
 * named for the slot it sits in; a refusal claimed under the surface key its
 * entry holds; a session read's class by whether the entry supplies it; and
 * a form's unread instance declaration claimed at the form whether or not
 * any expression of the form was registered. The failures this catches: a
 * refused slot whose uses go unclaimed, an HQ JSON slot whose shorthand
 * (`#case`, `#parent`, `#host`, `#user`) is claimed as the interpolated
 * casedb path or as the form builder's `#case/` hashtag, or whose raw text,
 * which Core's lexer refuses, is claimed for the grammar Core never reads in
 * it, a call's name not claimed as the name Core's lexer reads, a refusal recorded under a key
 * its entry does not hold, an unsupplied datum read claimed as supplied, and
 * a declaration left unclaimed in a form with no registered expression.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { inventoryIndex } from "../../../surface/inventory";
import { readExpressions } from "../index";
import {
	fieldNamed,
	onlyForm,
	readEnv,
	registration,
} from "./expressionReadFixture";

const M1 = "expressions-and-data/session-data-datum-the-entry-does-not-supply";

function visitDoc() {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "text", id: "q2", label: "Q2" }),
						],
					},
				],
			},
		],
	});
}

function relevantOf(doc: ReturnType<typeof visitDoc>, id: string) {
	return {
		entity: "field",
		uuid: fieldNamed(doc, id),
		slot: "relevant",
	} as const satisfies SlotContextRef;
}

describe("the claims beside each slot's own", () => {
	it("claims the uses of a refused slot, its refusal under a key its entry holds, each named for the slot", () => {
		const doc = visitDoc();
		const reading = readExpressions(
			doc,
			[registration(doc, relevantOf(doc, "q1"), "/data/q2 | /data/q1")],
			readEnv(),
		);
		const own = reading.claims.filter((claim) => claim.source === 0);
		const union = "expressions-and-data/union-a-b";
		// The slot's own claim, under the registration's key, by which the frame
		// finds it; and the same entry under a key of its own.
		expect(own[0]).toMatchObject({ entryId: union, key: "test:relevant" });
		const keys = own
			.filter((claim) => claim.entryId === union)
			.map((claim) => claim.key);
		expect(
			keys.some((key) =>
				inventoryIndex().entry(union)?.surfaceKeys.includes(key),
			),
		).toBe(true);
		expect(own.length).toBeGreaterThan(2);
		expect(new Set(own.map((claim) => claim.key)).size).toBe(own.length);
		for (const claim of own) expect(claim.detail.name).toBe("relevant");
	});

	it("claims a session read the entry does not supply under M1's class, and one it supplies under the held entry's", () => {
		const doc = visitDoc();
		const reading = readExpressions(
			doc,
			[
				registration(
					doc,
					relevantOf(doc, "q1"),
					"instance('commcaresession')/session/data/case_id_elsewhere = ''",
				),
				registration(
					doc,
					relevantOf(doc, "q2"),
					"instance('commcaresession')/session/data/case_id = ''",
				),
			],
			readEnv(),
		);
		const session = (source: number) =>
			reading.claims.find(
				(claim) =>
					claim.source === source &&
					claim.key === "session-path:session/data/*",
			)?.entryId;
		expect(session(0)).toBe(M1);
		expect(session(1)).toBe("expressions-and-data/session-data-datum");
	});

	it("claims an HQ JSON slot's shorthand as the pattern HQ's interpolation replaces, and no grammar of its raw text", () => {
		const doc = visitDoc();
		const ref = {
			entity: "form",
			uuid: onlyForm(doc),
			slot: "form_display_condition",
		} as const;
		const reading = readExpressions(
			doc,
			[
				registration(doc, ref, "#case/p = 'x'"),
				registration(doc, ref, "#parent/p = 'x' or #host/p = #user/q"),
			],
			readEnv(),
		);
		const keys = (source: number) =>
			reading.claims
				.filter((claim) => claim.source === source)
				.map((claim) => claim.key)
				.filter((key) => key.includes(":") && !key.startsWith("schema:"));
		const uses = (source: number) =>
			keys(source).filter(
				(key) => !key.startsWith("test:") && !key.startsWith("parser:"),
			);
		expect(uses(0)).toEqual(["hashtag:#case"]);
		expect(new Set(uses(1))).toEqual(
			new Set(["hashtag:#parent", "hashtag:#host", "hashtag:#user"]),
		);
	});

	it("claims the shorthand a slot HQ interpolates holds by its text, inside a string too, and `$fixture_value` only where a fixture is named", () => {
		const doc = visitDoc();
		const ref = {
			entity: "form",
			uuid: onlyForm(doc),
			slot: "form_display_condition",
		} as const;
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const tab = {
			...registration(
				doc,
				{ entity: "module", uuid: moduleUuid, slot: "case_list_filter" },
				"#parent/p = 'x'",
				{ target: "hq-json", interpolation: "case" },
			),
			usesOnly: true as const,
		};
		const reading = readExpressions(
			doc,
			[
				registration(doc, ref, "p = '#user/q'"),
				{
					...registration(doc, ref, "$fixture_value = 'a'"),
					fixtureValue: true,
				},
				registration(doc, ref, "$fixture_value = 'a'"),
				tab,
			],
			readEnv(),
		);
		const keys = (source: number) =>
			reading.claims
				.filter((claim) => claim.source === source)
				.map((claim) => claim.key);
		// HQ replaces `#user` inside the string, and Core reads the rest as written.
		expect(keys(0)).toEqual(
			expect.arrayContaining(["hashtag:#user", "xpath-token:STR"]),
		);
		expect(keys(1)).toContain("hashtag:$fixture_value");
		expect(keys(2)).not.toContain("hashtag:$fixture_value");
		// A text registered for its uses alone in a slot HQ interpolates: a tab's filter.
		expect(keys(3)).toContain("hashtag:#parent");
	});

	it("claims the shorthand of the whole text HQ interpolates where the registration reads a part, and none where the node is no slot HQ interpolates", () => {
		const doc = visitDoc();
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const filter = {
			entity: "module",
			uuid: moduleUuid,
			slot: "module_display_condition",
		} as const;
		const operand = registration(doc, filter, "p = 'a'");
		const reading = readExpressions(
			doc,
			[
				// The operand beside a clause whose part of the filter holds `#user`: Core refuses the
				// whole filter, so the slot uses its shorthand alone.
				{ ...operand, slotText: "p = 'a' and #user/x = 'b'" },
				// The same operand recorded at a node HQ does not interpolate.
				{ ...operand, text: "#user/x = 'b'", slotText: null },
				// A menu's case named by its slug: HQ's replacement leaves `:<slug>` after the path.
				registration(doc, filter, "#case:clinic/p = 'a'"),
				operand,
			],
			readEnv(),
		);
		const claimsOf = (source: number) =>
			reading.claims.filter((claim) => claim.source === source);
		const keys = (source: number) => claimsOf(source).map((claim) => claim.key);
		expect(keys(0)).toContain("hashtag:#user");
		expect(keys(0)).not.toContain("xpath-token:STR");
		expect(keys(1)).not.toContain("hashtag:#user");
		expect(
			claimsOf(2).find((claim) => claim.key === "hashtag:#case")?.entryId,
		).toBe(
			"expressions-and-data/case-module-slug-unrelated-parent-select-case",
		);
		// The operand alone: its grammar, and no shorthand.
		expect(keys(3)).toContain("xpath-token:STR");
		expect(keys(3)).not.toContain("hashtag:#user");
	});

	it("claims a call's name as the QNAME Core's lexer reads it as", () => {
		const doc = visitDoc();
		const reading = readExpressions(
			doc,
			[
				registration(
					doc,
					relevantOf(doc, "q1"),
					"today() > date('2020-01-01')",
				),
			],
			readEnv(),
		);
		const keys = reading.claims
			.filter((claim) => claim.source === 0)
			.map((claim) => claim.key);
		expect(keys).toContain("xpath-token:QNAME");
		expect(keys).toContain("jr-fn:today");
	});

	it("claims a form's unread declaration at the form, with no expression of the form registered", () => {
		const doc = visitDoc();
		const form = onlyForm(doc);
		const place: HqPlace = {
			kind: "form",
			menu: 0,
			form: 0,
			menuName: "Patients",
			name: "Visit",
		};
		const reading = readExpressions(
			doc,
			[],
			readEnv({
				instanceSources: new Map<Uuid, ReadonlyMap<string, string>>([
					[form, new Map([["groups", "jr://fixture/user-groups"]])],
				]),
				formPlaces: new Map([[form, place]]),
			}),
		);
		expect(reading.claims).toEqual([
			{
				source: -1,
				entryId:
					"expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user",
				place,
				key: "instance-source:fixture",
				detail: { name: "instance" },
			},
		]);
	});
});
