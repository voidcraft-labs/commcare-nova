/**
 * What the expressions read of the worker: the first run lists each name a
 * worker read names, the entities minted from that list are added, and the
 * second run binds the reads to them. The failures this holds: a read still
 * name-backed on the second run; a built-in name missing from the first
 * run's list (it stays name-backed by the minting rule, which must see it);
 * a third run that differs from the second.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import { mintingResolver } from "../../identity";
import { worldEntitiesFromReads } from "../../worldEntities";
import { readExpressions } from "../index";
import { fieldNamed, readEnv, registration } from "./expressionReadFixture";

describe("the worker's reads, learned by a first run", () => {
	it("binds a read of worker data to the property minted from the first run", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		};
		const pending = [
			registration(
				doc,
				relevant,
				"instance('commcaresession')/session/user/data/role = 'chw' and instance('commcaresession')/session/user/data/commcare_location_id != ''",
			),
		];
		const env = readEnv();
		const first = readExpressions(doc, pending, env);
		expect(first.worldReads.userFields).toEqual([
			"commcare_location_id",
			"role",
		]);
		const minted = worldEntitiesFromReads(
			first.worldReads,
			mintingResolver("app"),
		);
		const persisted = toPersistableDoc(doc);
		const withWorld = hydratePersistedBlueprint({
			...persisted,
			userProperties: Object.fromEntries(
				minted.userProperties.map((property) => [property.uuid, property]),
			),
			userPropertyOrder: minted.userProperties.map((property) => property.uuid),
		} as typeof persisted);
		const second = readExpressions(withWorld, pending, env);
		expect(second.bound[0]).toMatchObject({
			kind: "and",
			clauses: [
				{ left: { kind: "term", term: { kind: "session-user-property" } } },
				{
					left: {
						kind: "term",
						term: { kind: "session-user", field: "commcare_location_id" },
					},
				},
			],
		});
		const third = readExpressions(withWorld, pending, env);
		expect(third.bound).toEqual(second.bound);
		expect(third.claims).toEqual(second.claims);
	});

	it("binds a read of the worker's own case to the property minted from the first run", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		};
		// `#user/role`, as HQ's build writes it into a form.
		const pending = [
			registration(
				doc,
				relevant,
				"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/role = 'chw'",
			),
		];
		const env = readEnv();
		const first = readExpressions(doc, pending, env);
		expect(first.bound[0]).toMatchObject({
			left: {
				kind: "term",
				term: { kind: "session-user", field: "role", source: "worker-record" },
			},
		});
		expect(first.worldReads.userFields).toEqual(["role"]);
		const minted = worldEntitiesFromReads(
			first.worldReads,
			mintingResolver("app"),
		);
		const [role] = minted.userProperties;
		if (role === undefined) throw new Error("No worker property was minted.");
		const persisted = toPersistableDoc(doc);
		const withWorld = hydratePersistedBlueprint({
			...persisted,
			userProperties: { [role.uuid]: role },
			userPropertyOrder: [role.uuid],
		} as typeof persisted);
		const second = readExpressions(withWorld, pending, env);
		expect(second.bound[0]).toMatchObject({
			left: {
				kind: "term",
				term: {
					kind: "session-user-property",
					userPropertyUuid: role.uuid,
					source: "worker-record",
				},
			},
		});
		expect(second.worldReads.userFields).toEqual([]);
		expect(second.circumstances).toEqual([]);
	});

	it("names no worker property for a field CommCare HQ writes on the worker's own case", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		};
		// `username` is one of the fields HQ writes on every worker's case
		// (`callcenter/sync_usercase.py::_get_user_case_fields`).
		const pending = [
			registration(
				doc,
				relevant,
				"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/username != ''",
			),
		];
		const first = readExpressions(doc, pending, readEnv());
		expect(first.bound[0]).toMatchObject({
			left: {
				kind: "term",
				term: {
					kind: "session-user",
					field: "username",
					source: "worker-record",
				},
			},
		});
		expect(first.worldReads.userFields).toEqual([]);
	});
});
