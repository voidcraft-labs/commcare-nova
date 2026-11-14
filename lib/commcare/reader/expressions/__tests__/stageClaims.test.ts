/**
 * The claims the expression stage returns beside each slot's own: the uses
 * an expression's text makes, held or not, before HQ's interpolation, each
 * named for the slot it sits in; a refusal claimed under the surface key its
 * entry holds; a session read's class by whether the entry supplies it; and
 * a form's unread instance declaration claimed at the form whether or not
 * any expression of the form was registered. The failures this catches: a
 * refused slot whose uses go unclaimed, an HQ JSON slot whose `#case` read
 * is claimed as the interpolated casedb path, a refusal recorded under a key
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

	it("claims an HQ JSON slot's `#case` read as the hashtag, before HQ's interpolation", () => {
		const doc = visitDoc();
		const ref = {
			entity: "form",
			uuid: onlyForm(doc),
			slot: "form_display_condition",
		} as const;
		const reading = readExpressions(
			doc,
			[registration(doc, ref, "#case/p = 'x'")],
			readEnv(),
		);
		const keys = reading.claims
			.filter((claim) => claim.source === 0)
			.map((claim) => claim.key);
		expect(keys).toContain("hashtag:#case/");
		expect(keys.some((key) => key.startsWith("instance-scheme:casedb"))).toBe(
			false,
		);
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
