// scripts/__tests__/legacyMediaRefs.test.ts
//
// Coverage for the media-reference arm behind the legacy scripts'
// `--media` flag (`scripts/lib/legacyMediaRefs.ts`):
//
//   1. Classification — the bytes line: row-missing and stale-pending
//      are DEAD; foreign-owned, young-pending, and ready-wrong-kind are
//      NEEDS-OWNER; a healthy ref is neither.
//   2. The clear planner — dead refs clear through the clear-safe
//      mutation kinds, composing per carrier (the live sibling slot and
//      the live bundle kind survive), and the cleared identities are
//      verifiably GONE from the post-apply walk.
//   3. The image-map carve-out — a dead image-map ref is unclearable
//      (the row's image is schema-required), reported needs-owner.
//   4. The whole plan passes the same commit gate every live write
//      surface runs.
//
// The core is pure (doc + rows in → report/plan out); `loadAssetRowsForScan`
// is the only database-touching function and takes its handle as a
// parameter, so no import-boundary stub is needed here.

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { asAssetId, type BlueprintDoc, type Field } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import {
	classifyMediaRefs,
	mediaRefIdentity,
	planMediaRefClears,
	type ScanAssetRow,
	STALE_PENDING_WINDOW_MS,
} from "../lib/legacyMediaRefs";

const NOW = 1_900_000_000_000;
const OWNER = "owner-1";

function row(
	id: string,
	overrides: Partial<Omit<ScanAssetRow, "id">> = {},
): [string, ScanAssetRow] {
	return [
		id,
		{
			id,
			owner: OWNER,
			status: "ready",
			kind: "image",
			createdAtMs: NOW - 60_000,
			...overrides,
		},
	];
}

/**
 * One module with every carrier shape the planner handles: app logo,
 * module menu (dead icon + LIVE audio label), a select field with option
 * media, a text field with a label bundle (dead image + LIVE audio), and
 * an image-map case-list column.
 */
function mediaDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Media App",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Patient",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Enroll",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "single_select",
								id: "symptom",
								label: "Symptom",
								options: [
									{ value: "fever", label: "Fever" },
									{ value: "cough", label: "Cough" },
								],
							}),
						],
					},
				],
			},
		],
	});

	doc.logo = asAssetId("dead-logo");
	const mod = doc.modules[doc.moduleOrder[0]];
	mod.icon = asAssetId("dead-icon");
	mod.audioLabel = asAssetId("live-audio");
	if (mod.caseListConfig) {
		mod.caseListConfig = {
			...mod.caseListConfig,
			columns: [
				...mod.caseListConfig.columns,
				{
					kind: "image-map",
					uuid: doc.moduleOrder[0],
					field: "case_name",
					header: "Status",
					mapping: [{ value: "open", assetId: "dead-mapimg" }],
				} as (typeof mod.caseListConfig.columns)[number],
			],
		};
	}
	const fields = Object.values(doc.fields);
	const textField = fields.find((fl) => fl.id === "case_name") as Field & {
		label_media?: { image?: string; audio?: string };
	};
	textField.label_media = { image: "dead-bundle-img", audio: "live-audio" };
	const selectField = fields.find((fl) => fl.id === "symptom") as Field & {
		options: { value: string; label: string; media?: { image?: string } }[];
	};
	selectField.options = [
		{ value: "fever", label: "Fever", media: { image: "dead-option-img" } },
		{ value: "cough", label: "Cough" },
	];
	return doc;
}

/** Rows: every `live-*` id is ready+matching; `dead-*` ids are absent. */
function liveRows(): Map<string, ScanAssetRow> {
	return new Map([row("live-audio", { kind: "audio" })]);
}

describe("classifyMediaRefs", () => {
	it("judges each reference by whether usable bytes exist", () => {
		const doc = buildDoc({ appName: "X" });
		doc.logo = asAssetId("the-asset");
		const judge = (rows: Map<string, ScanAssetRow>) =>
			classifyMediaRefs(doc, OWNER, rows, { nowMs: NOW });

		// Row missing → dead.
		expect(judge(new Map()).dead).toHaveLength(1);

		// Stale pending (past the one-day window) → dead.
		const stale = judge(
			new Map([
				row("the-asset", {
					status: "pending",
					createdAtMs: NOW - STALE_PENDING_WINDOW_MS - 1,
				}),
			]),
		);
		expect(stale.dead).toHaveLength(1);
		expect(stale.dead[0].reason).toContain("stuck pending");

		// Young pending → needs-owner (the upload may still confirm).
		const young = judge(
			new Map([
				row("the-asset", { status: "pending", createdAtMs: NOW - 60_000 }),
			]),
		);
		expect(young.dead).toHaveLength(0);
		expect(young.needsOwner).toHaveLength(1);

		// Foreign-owned → needs-owner, never auto-cleared.
		const foreign = judge(new Map([row("the-asset", { owner: "someone" })]));
		expect(foreign.dead).toHaveLength(0);
		expect(foreign.needsOwner[0].reason).toContain("different account");

		// Ready but the wrong kind for the slot → needs-owner (usable bytes).
		const wrongKind = judge(new Map([row("the-asset", { kind: "audio" })]));
		expect(wrongKind.dead).toHaveLength(0);
		expect(wrongKind.needsOwner[0].reason).toContain("audio");

		// Healthy → neither.
		const healthy = judge(new Map([row("the-asset")]));
		expect(healthy.dead).toHaveLength(0);
		expect(healthy.needsOwner).toHaveLength(0);
		expect(healthy.total).toBe(1);
	});
});

describe("planMediaRefClears", () => {
	it("clears every dead carrier shape, preserves live siblings, and passes the commit gate", () => {
		const doc = mediaDoc();
		const report = classifyMediaRefs(doc, OWNER, liveRows(), { nowMs: NOW });
		// Dead: logo, module icon, bundle image, option image, image-map.
		expect(report.dead).toHaveLength(5);
		expect(report.needsOwner).toHaveLength(0);

		const plan = planMediaRefClears(doc, report.dead);
		// The image-map ref is unclearable (schema-required image slot).
		expect(plan.unclearable).toHaveLength(1);
		expect(plan.unclearable[0].ref.location.kind).toBe("image_map_mapping");
		// Four clears: logo, module icon, field bundle image, option image.
		expect(plan.notes).toHaveLength(4);

		const gate = mutationCommitVerdict(doc, plan.mutations);
		expect(gate.ok).toBe(true);
		if (!gate.ok) return;

		// Every cleared identity is GONE from the post-apply walk…
		const remaining = new Set(
			[...walkAssetRefs(gate.nextDoc)].map(mediaRefIdentity),
		);
		for (const identity of plan.clearedIdentities) {
			expect(remaining.has(identity)).toBe(false);
		}

		// …while the live slots survived intact.
		const mod = gate.nextDoc.modules[gate.nextDoc.moduleOrder[0]];
		expect(mod.icon).toBeUndefined();
		expect(mod.audioLabel).toBe("live-audio");
		const textField = Object.values(gate.nextDoc.fields).find(
			(fl) => fl.id === "case_name",
		) as Field & { label_media?: { image?: string; audio?: string } };
		expect(textField.label_media).toEqual({ audio: "live-audio" });
		const selectField = Object.values(gate.nextDoc.fields).find(
			(fl) => fl.id === "symptom",
		) as Field & {
			options: { value: string; label: string; media?: unknown }[];
		};
		expect(selectField.options[0]).toEqual({ value: "fever", label: "Fever" });
		expect(gate.nextDoc.logo).toBeUndefined();
	});

	it("plans nothing for an app whose references all resolve", () => {
		const doc = mediaDoc();
		const rows = new Map([
			row("live-audio", { kind: "audio" }),
			row("dead-logo"),
			row("dead-icon"),
			row("dead-bundle-img"),
			row("dead-option-img"),
			row("dead-mapimg"),
		]);
		const report = classifyMediaRefs(doc, OWNER, rows, { nowMs: NOW });
		expect(report.dead).toHaveLength(0);
		const plan = planMediaRefClears(doc, report.dead);
		expect(plan.mutations).toHaveLength(0);
		expect(plan.notes).toHaveLength(0);
	});
});
