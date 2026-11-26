/**
 * Contract: the Connect conversion turns a released document (an app-wide
 * `connectType` and each form's `connect` blocks) into the positioned
 * activities the current document holds, and the converted app prints the
 * same forms the released app printed. The plausible failures: a block lands
 * at another submitted position or in another order, a default the released
 * writer filled in goes missing, a reference to a block stops naming it, two
 * converts of one app mint different identities, or a minted identity takes
 * one an entity already holds. The released side of the comparison is the
 * forms main `3e16e43f` exported for its own Connect fixtures, recorded in
 * `fixtures/released-connect-3e16e43f.json` by that release's `expandDoc`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { convert } from "../migrations/step7-connect-activities.mjs";

interface ReleasedFixture {
	readonly name: string;
	readonly released: Record<string, unknown>;
	readonly xforms: Record<string, string>;
}

const fixtures: readonly ReleasedFixture[] = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "fixtures", "released-connect-3e16e43f.json"),
		"utf8",
	),
);

type Snapshot = {
	connectType?: unknown;
	connectRoles?: unknown;
	forms: Record<string, Record<string, unknown>>;
	fields: Record<string, Record<string, unknown>>;
	fieldOrder: Record<string, string[]>;
	[key: string]: unknown;
};

function converted(released: Record<string, unknown>, appId = "test-app") {
	return convert(structuredClone(released), {}, { appId }) as Snapshot;
}

function admitted(snapshot: Snapshot) {
	return hydratePersistedBlueprint(blueprintDocSchema.parse(snapshot));
}

describe("the Connect conversion", () => {
	it("prints every released form byte for byte from the converted document", () => {
		expect(fixtures.map((fixture) => fixture.name)).toEqual([
			"learn-default",
			"learn-custom",
			"deliver-default",
			"deliver-custom",
			"absent",
		]);
		for (const { name, released, xforms } of fixtures) {
			const doc = admitted(converted(released));
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE), name).toEqual([]);
			const hq = expandDoc(doc) as unknown as {
				_attachments: Record<string, string>;
			};
			expect(Object.keys(hq._attachments).sort(), name).toEqual(
				Object.keys(xforms).sort(),
			);
			for (const [key, xml] of Object.entries(xforms))
				expect(hq._attachments[key], `${name} ${key}`).toBe(xml);
		}
	});

	it("takes the released role into the role set and keeps a role without blocks", () => {
		const roles = fixtures.map(
			({ released }) => converted(released).connectRoles,
		);
		expect(roles).toEqual([["learn"], ["learn"], ["deliver"], ["deliver"], []]);
		const deliver = fixtures.find((f) => f.name === "deliver-default");
		if (!deliver) throw new Error("Missing the deliver fixture.");
		const bare = structuredClone(deliver.released) as Snapshot;
		for (const form of Object.values(bare.forms)) delete form.connect;
		const result = converted(bare);
		expect(result.connectRoles).toEqual(["deliver"]);
		expect(Object.hasOwn(result, "connectType")).toBe(false);
		expect(
			Object.values(result.fields).some(
				(field) => field.kind === "connect_activity",
			),
		).toBe(false);
		expect(runValidation(admitted(result), LOOKUP_CONTEXT_UNAVAILABLE)).toEqual(
			[],
		);
	});

	it("appends each form's blocks after its fields in the released block order, with the released defaults written out", () => {
		const learn = fixtures.find((f) => f.name === "learn-default");
		if (!learn) throw new Error("Missing the learn fixture.");
		const result = converted(learn.released);
		const [formUuid] = Object.keys(result.forms);
		const order = result.fieldOrder[formUuid].map((uuid) => {
			const field = result.fields[uuid];
			return [
				field.id,
				field.kind === "connect_activity"
					? (field.activity as { kind: string }).kind
					: field.kind,
			];
		});
		expect(order).toEqual([
			["score", "int"],
			["feedback", "text"],
			["lesson", "learning-module"],
			["quiz", "assessment"],
		]);
		const quiz = Object.values(result.fields).find((f) => f.id === "quiz");
		expect(quiz?.activity).toEqual({
			kind: "assessment",
			score: { kind: "term", term: { kind: "literal", value: 100 } },
		});
		const lesson = Object.values(result.fields).find((f) => f.id === "lesson");
		expect(lesson?.activity).toEqual({
			kind: "learning-module",
			name: "Health & care <雪>",
			description: "Read 'A' then \"B\"",
			estimatedHours: 5,
		});
		expect(Object.hasOwn(result.forms[formUuid], "connect")).toBe(false);

		const deliver = fixtures.find((f) => f.name === "deliver-default");
		if (!deliver) throw new Error("Missing the deliver fixture.");
		const visit = Object.values(converted(deliver.released).fields).find(
			(f) => f.id === "visit",
		);
		const username = {
			kind: "term",
			term: {
				kind: "session-user",
				field: "username",
				source: "worker-record",
			},
		};
		expect(visit?.activity).toEqual({
			kind: "delivery",
			name: "Home & clinic <雪>",
			entityId: {
				kind: "concat",
				parts: [
					username,
					{ kind: "term", term: { kind: "literal", value: "-" } },
					{ kind: "today" },
				],
			},
			entityName: username,
		});
	});

	it("mints the same identities for one app every time, and others for another app", () => {
		const { released } = fixtures[0];
		const uuids = (snapshot: Snapshot) =>
			Object.values(snapshot.fields)
				.filter((field) => field.kind === "connect_activity")
				.map((field) => field.uuid);
		const first = uuids(converted(released));
		expect(first).toHaveLength(2);
		expect(new Set(first).size).toBe(2);
		expect(uuids(converted(released))).toEqual(first);
		const other = uuids(converted(released, "another-app"));
		expect(other.some((uuid) => first.includes(uuid))).toBe(false);
	});

	it("refuses to mint an identity an entity of the app already holds", () => {
		const { released } = fixtures[0];
		const [minted] = Object.values(converted(released).fields)
			.filter((field) => field.kind === "connect_activity")
			.map((field) => field.uuid as string);
		const clash = structuredClone(released) as Snapshot;
		const [moduleUuid] = Object.keys(clash.modules as object);
		(clash.modules as Record<string, unknown>)[minted] = {
			...(clash.modules as Record<string, object>)[moduleUuid],
			uuid: minted,
		};
		expect(() => converted(clash)).toThrow(
			"An existing app entity holds the identity needed for a Connect activity.",
		);
	});

	it("repoints a reference to a block at its activity and keeps a reference to a block's part", () => {
		const custom = fixtures.find((f) => f.name === "learn-custom");
		if (!custom) throw new Error("Missing the learn fixture.");
		const released = structuredClone(custom.released) as Snapshot;
		const [formUuid] = Object.keys(released.forms);
		const feedback = Object.values(released.fields).find(
			(field) => field.id === "feedback",
		);
		if (!feedback) throw new Error("Missing the feedback field.");
		feedback.relevant = {
			kind: "and",
			left: {
				kind: "exists",
				of: {
					kind: "form-node",
					node: { kind: "connect-learn", form: formUuid, role: "block" },
					spelling: "absolute",
				},
			},
			right: {
				kind: "exists",
				of: {
					kind: "form-node",
					node: { kind: "connect-assessment", form: formUuid, role: "score" },
					spelling: "absolute",
				},
			},
		};
		const result = converted(released);
		const activity = (id: string) =>
			Object.values(result.fields).find((field) => field.id === id)?.uuid;
		const relevant = Object.values(result.fields).find(
			(field) => field.id === "feedback",
		)?.relevant as {
			left: { of: unknown };
			right: { of: unknown };
		};
		expect(relevant.left.of).toEqual({
			kind: "field",
			uuid: activity("lesson"),
			spelling: "absolute",
		});
		expect(relevant.right.of).toEqual({
			kind: "form-node",
			node: {
				kind: "connect-assessment",
				activity: activity("quiz"),
				role: "score",
			},
			spelling: "absolute",
		});
	});

	it("refuses a document that is not the released shape, and a reference to a block its form lacks", () => {
		const { released } = fixtures[0];
		const current = converted(released);
		expect(() => convert(current, {}, { appId: "test-app" })).toThrow(
			"Connect conversion requires its released document and app identity.",
		);
		expect(() => convert(structuredClone(released), {}, { appId: "" })).toThrow(
			"Connect conversion requires its released document and app identity.",
		);
		const dangling = structuredClone(released) as Snapshot;
		const [formUuid] = Object.keys(dangling.forms);
		const score = Object.values(dangling.fields).find(
			(field) => field.id === "score",
		);
		if (!score) throw new Error("Missing the score field.");
		score.relevant = {
			kind: "exists",
			of: {
				kind: "form-node",
				node: { kind: "connect-delivery", form: formUuid, role: "block" },
				spelling: "absolute",
			},
		};
		expect(() => converted(dangling)).toThrow(
			"A saved expression names a Connect activity its form does not contain.",
		);
	});
});
