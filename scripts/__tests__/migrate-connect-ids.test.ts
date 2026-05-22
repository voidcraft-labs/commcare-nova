// scripts/__tests__/migrate-connect-ids.test.ts
//
// Coverage for the one-time connect-id heal. The script (and this test)
// are transient — they get deleted once existing apps are healed — so the
// surface is just the pure `healConnectIds(doc)` transform:
//
//   - id-less block → autofilled from the module/form name.
//   - present-but-invalid id (bad chars, or >50) → re-derived (normalized).
//   - duplicate ids across blocks → the second (document order) re-derived.
//   - every healed id is valid (`connectIdError === null`) and unique.
//   - idempotent: a second pass over healed data changes nothing.
//
// The heal reuses the PERMANENT shared helpers (`deriveConnectId`,
// `connectIdError`); only the heal loop lives in the script. No
// mocked-Firestore `run(...)` coverage — the CLI plumbing mirrors the
// long-lived `migrate-event-source.ts` shape and the script is throwaway.

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	CONNECT_SLUG_MAX_LENGTH,
	connectIdError,
} from "@/lib/commcare/connectSlugs";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc, ConnectConfig } from "@/lib/domain";
import { healConnectIds } from "../migrate-connect-ids";

/** Build a one-module learn doc whose single form carries `connect`. */
function learnDoc(
	connect: ConnectConfig,
	moduleName = "Training",
): BlueprintDoc {
	return buildDoc({
		connectType: "learn",
		modules: [
			{
				name: moduleName,
				forms: [{ name: "Lesson", type: "survey", connect }],
			},
		],
	});
}

/** Read the (single) form's healed connect config. */
function onlyConnect(doc: BlueprintDoc): ConnectConfig | null | undefined {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return doc.forms[formUuid]?.connect;
}

/** Assert every present connect id in the doc is valid + within length. */
function expectAllValid(doc: BlueprintDoc): void {
	for (const formUuid of Object.keys(doc.forms)) {
		const c = doc.forms[formUuid as keyof typeof doc.forms]?.connect;
		if (!c) continue;
		for (const id of [
			c.learn_module?.id,
			c.assessment?.id,
			c.deliver_unit?.id,
			c.task?.id,
		]) {
			if (id !== undefined) expect(connectIdError(id)).toBeNull();
		}
	}
}

describe("healConnectIds", () => {
	it("autofills an id-less block from the module name", () => {
		const doc = learnDoc({
			learn_module: { name: "Intro", description: "x", time_estimate: 5 },
		});
		const { doc: healed, changes } = healConnectIds(doc);
		expect(onlyConnect(healed)?.learn_module?.id).toBe("training");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.reason).toBe("missing");
	});

	it("re-derives an id with illegal characters", () => {
		const doc = learnDoc({
			learn_module: {
				id: "2024 Intake",
				name: "Intro",
				description: "x",
				time_estimate: 5,
			},
		});
		const { doc: healed, changes } = healConnectIds(doc);
		const id = onlyConnect(healed)?.learn_module?.id as string;
		expect(connectIdError(id)).toBeNull();
		expect(id).not.toBe("2024 Intake");
		expect(changes[0]?.reason).toBe("invalid-chars");
	});

	it("re-derives an over-length id to ≤50 chars", () => {
		const longId = "a".repeat(60);
		const doc = learnDoc({
			learn_module: {
				id: longId,
				name: "Intro",
				description: "x",
				time_estimate: 5,
			},
		});
		const { doc: healed, changes } = healConnectIds(doc);
		const id = onlyConnect(healed)?.learn_module?.id as string;
		expect(id.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
		expect(connectIdError(id)).toBeNull();
		expect(changes[0]?.reason).toBe("too-long");
	});

	it("re-derives the second of two blocks that share a valid id", () => {
		// Two learn modules on two forms both carry id "intro" — the first
		// (document order) keeps it, the second is re-derived to a distinct
		// valid id. (Distinct modules so app-wide uniqueness applies.)
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training A",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "intro",
									name: "A",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
				{
					name: "Training B",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "intro",
									name: "B",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		const { doc: healed, changes } = healConnectIds(doc);
		const ids = healed.moduleOrder.map(
			(m) => healed.forms[healed.formOrder[m][0]]?.connect?.learn_module?.id,
		);
		expect(ids[0]).toBe("intro"); // first keeps it
		expect(ids[1]).not.toBe("intro"); // second re-derived
		expect(new Set(ids).size).toBe(2);
		expectAllValid(healed);
		// Exactly one change — the duplicate second occurrence.
		expect(changes).toHaveLength(1);
		expect(changes[0]?.reason).toBe("duplicate");
	});

	it("heals a mix of missing + bad-char + over-length in one doc", () => {
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								// missing id, plus a co-located assessment with a bad-char id
								learn_module: {
									name: "L",
									description: "x",
									time_estimate: 5,
								},
								assessment: { id: "bad id!", user_score: "100" },
							},
						},
						{
							name: "Quiz",
							type: "survey",
							connect: {
								// over-length id
								assessment: { id: "z".repeat(60), user_score: "100" },
							},
						},
					],
				},
			],
		});
		const { doc: healed } = healConnectIds(doc);
		expectAllValid(healed);
		// All ids distinct across the app.
		const all = healed.moduleOrder.flatMap((m) =>
			healed.formOrder[m].flatMap((fid) => {
				const c = healed.forms[fid]?.connect;
				return [c?.learn_module?.id, c?.assessment?.id].filter(
					(x): x is string => x !== undefined,
				);
			}),
		);
		expect(new Set(all).size).toBe(all.length);
	});

	it("is idempotent — a second pass over healed data changes nothing", () => {
		const doc = learnDoc({
			learn_module: {
				id: "2024 Intake",
				name: "Intro",
				description: "x",
				time_estimate: 5,
			},
			assessment: { id: "b".repeat(60), user_score: "100" },
		});
		const first = healConnectIds(doc);
		expect(first.changes.length).toBeGreaterThan(0);
		const second = healConnectIds(first.doc);
		expect(second.changes).toEqual([]);
		expect(second.doc).toEqual(first.doc);
	});

	it("returns no changes for a doc whose ids are already valid + unique", () => {
		const doc = learnDoc({
			learn_module: {
				id: "intro_module",
				name: "Intro",
				description: "x",
				time_estimate: 5,
			},
			assessment: { id: "intro_quiz", user_score: "100" },
		});
		const { changes } = healConnectIds(doc);
		expect(changes).toEqual([]);
	});

	it("leaves non-Connect apps untouched", () => {
		const doc = buildDoc({
			connectType: null,
			modules: [{ name: "M", forms: [{ name: "F", type: "survey" }] }],
		});
		const { changes } = healConnectIds(doc);
		expect(changes).toEqual([]);
	});
});

// ── End-to-end: heal → expand emits valid wire ───────────────────────
//
// The load-bearing claim: after the heal runs, the doc compiles to valid
// CommCare. A doc carrying a 60-char id + a bad-char id is healed, expanded,
// and every emitted Connect element name is a legal XML element name and
// ≤50 chars — so `narrowId` never throws and the upload won't 500.

describe("healConnectIds → expandDoc", () => {
	/** Connect wrapper element names (the ids) carrying any `vellum:role`. */
	function connectElementNames(xml: string): string[] {
		return [...xml.matchAll(/<([^\s<>]+) vellum:role="Connect[^"]*">/g)].map(
			(m) => m[1],
		);
	}

	it("a 60-char and a bad-char id heal to a valid, ≤50, compilable wire", () => {
		const doc = buildDoc({
			appName: "Legacy",
			connectType: "learn",
			modules: [
				{
					name: "Training",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "a".repeat(60), // over-length
									name: "Intro",
									description: "x",
									time_estimate: 5,
								},
								assessment: { id: "bad id!", user_score: "100" }, // bad chars
							},
						},
					],
				},
			],
		});

		const { doc: healed } = healConnectIds(doc);

		// expandDoc must not throw (narrowId's invariant holds post-heal).
		const hq = expandDoc(healed);
		const xml = Object.values(hq._attachments)[0] as string;

		const names = connectElementNames(xml);
		expect(names.length).toBe(2); // learn_module + assessment
		for (const name of names) {
			expect(name.length).toBeLessThanOrEqual(CONNECT_SLUG_MAX_LENGTH);
			expect(connectIdError(name)).toBeNull();
		}
	});
});
