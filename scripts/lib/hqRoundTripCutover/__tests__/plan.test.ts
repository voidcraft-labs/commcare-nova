/**
 * The plan's digest: the frozen proof of everything the cutover decides,
 * and of no content HQ holds. It must not move when only a read time, the
 * answering member or HQ's content moves with every class and identity row
 * equal, and must move when anything the cutover writes about moves.
 */

import { describe, expect, it } from "vitest";
import { classifyDeployment, type DeploymentReads } from "../hqRead";
import { readRawDocument } from "../oldShape";
import {
	type AppPlan,
	type CutoverPlan,
	cutoverPlanDigest,
	type DeploymentPlan,
	PLAN_FORMAT,
} from "../plan";
import { questionPaths } from "../questionPaths";
import { HISTORIES } from "./fixtures/fixtureDocuments";
import {
	readFixtureCarriers,
	readFixtureHistory,
	readHistoryCarriers,
} from "./fixtures/preStep";
import {
	retainedCutoverRead,
	retainedFormIds,
	retainedSource,
} from "./fixtures/retainedCutoverReads";

function deployment(patch: Partial<DeploymentPlan> = {}): DeploymentPlan {
	return {
		deploymentId: "00000000-0000-7000-8000-00000000d001",
		server: "production",
		domain: "field-ops",
		remoteAppId: "remote-app-1",
		outcome: "read-in-full",
		buildSpecVersion: "2.60.0",
		pairing: { path: "published-document", source: "stored" },
		identities: [
			{
				entityKind: "form",
				novaEntityUuid: "00000000-0000-4000-8000-00000000f001",
				remoteUniqueId: "hq-form-1",
				remoteXmlns: null,
			},
		],
		keyUses: [
			{
				userId: "member-a",
				firstUsedAt: "2026-10-15T10:00:00.000Z",
				lastUsedAt: "2026-10-15T10:00:07.000Z",
			},
		],
		unpaired: [],
		formIdsUnknown: [],
		notices: [{ reason: "deep-links-need-republish" }],
		...patch,
	};
}

function app(patch: Partial<AppPlan> = {}): AppPlan {
	return {
		appId: "app-1",
		projectId: "project-1",
		baseSeq: 7,
		baseDigest: "a".repeat(64),
		targetDigest: "b".repeat(64),
		blockers: [],
		changes: [],
		discardsPrivateWork: false,
		deployments: [deployment()],
		...patch,
	};
}

function plan(patch: Partial<Omit<CutoverPlan, "digest">> = {}) {
	return cutoverPlanDigest({
		format: PLAN_FORMAT,
		apps: [app()],
		lookupTagRenames: [],
		projectBlockers: [],
		...patch,
	});
}

describe("the plan digest", () => {
	const base = plan();

	it("is the same on every run over the same decisions", () => {
		expect(plan()).toBe(base);
	});

	it.each([
		[
			"a read time and the answering member",
			deployment({
				keyUses: [
					{
						userId: "member-b",
						firstUsedAt: "2026-10-16T11:00:00.000Z",
						lastUsedAt: "2026-10-16T11:30:00.000Z",
					},
				],
			}),
		],
		["HQ's build_spec.version", deployment({ buildSpecVersion: "2.64.1" })],
		["the notice lines HQ's content decides", deployment({ notices: [] })],
		[
			"the path that paired it",
			deployment({ pairing: { path: "evidence", reason: "hq-differs" } }),
		],
	])("does not move with %s", (_label, moved) => {
		expect(plan({ apps: [app({ deployments: [moved] })] })).toBe(base);
	});

	it.each([
		["one app's base sequence", app({ baseSeq: 8 })],
		["one app's base digest", app({ baseDigest: "c".repeat(64) })],
		["one app's target", app({ targetDigest: "d".repeat(64) })],
		[
			"one app's changes",
			app({
				changes: [
					{
						reason: "unsaved-assistant-work-discarded",
						entity: { type: "app", nameAtMigration: "Clinic" },
					},
				],
			}),
		],
		["one app's private work", app({ discardsPrivateWork: true })],
		[
			"a blocker added",
			app({
				blockers: [{ code: "case-schema-change", count: 1, findingCodes: [] }],
			}),
		],
		[
			"one deployment's class",
			app({ deployments: [deployment({ outcome: "unreadable" })] }),
		],
		[
			"an identity row added",
			app({
				deployments: [
					deployment({
						identities: [
							...deployment().identities,
							{
								entityKind: "module",
								novaEntityUuid: "00000000-0000-4000-8000-00000000e001",
								remoteUniqueId: "hq-menu-1",
								remoteXmlns: null,
							},
						],
					}),
				],
			}),
		],
		[
			"an identity row dropped",
			app({ deployments: [deployment({ identities: [] })] }),
		],
		[
			"an identity row changed",
			app({
				deployments: [
					deployment({
						identities: [
							{
								entityKind: "form",
								novaEntityUuid: "00000000-0000-4000-8000-00000000f001",
								remoteUniqueId: "hq-form-1",
								remoteXmlns: "http://openrosa.org/formdesigner/moved",
							},
						],
					}),
				],
			}),
		],
	])("moves with %s", (_label, moved) => {
		expect(plan({ apps: [moved] })).not.toBe(base);
	});

	it("moves with the tag rename map and a Project blocker", () => {
		expect(
			plan({
				lookupTagRenames: [
					{
						projectId: "project-1",
						tableId: "018f0000-0000-7000-8000-000000000001",
						fromTag: "clinic_casedb_codes",
						toTag: "clinic_case_db_codes",
					},
				],
			}),
		).not.toBe(base);
		expect(
			plan({
				projectBlockers: [
					{
						projectId: "project-1",
						tableId: "018f0000-0000-7000-8000-000000000001",
						code: "lookup-tag-rename-collision",
						referencingAppIds: ["app-1"],
					},
				],
			}),
		).not.toBe(base);
	});
});

describe("each deployment's pairing over HQ's reads of a history", () => {
	async function readsOf(document: string): Promise<DeploymentReads> {
		return {
			source: {
				kind: "ok",
				value: await retainedSource(
					retainedCutoverRead(document, "after-create", "app-source.json"),
				),
			},
			formIds: {
				kind: "ok",
				value: await retainedFormIds(
					retainedCutoverRead(document, "after-create", "application.json"),
				),
			},
			keyUses: [],
			sourceAnswer: { userId: "member", at: "2026-10-15T10:00:00.000Z" },
		};
	}

	function sides(document: string, name: string) {
		const rows = readFixtureHistory(document, name).rows;
		return {
			published: questionPaths(
				readRawDocument(document, readFixtureCarriers(document)),
			),
			today: questionPaths(
				readRawDocument(
					document,
					readHistoryCarriers(document, name, rows.at(-1)?.seq ?? 1),
				),
			),
		};
	}

	it.each(
		HISTORIES.filter((history) => history.name !== "twin-moved").map(
			(history) => [history.document, history.name],
		),
	)(
		"gives %s's history %s the same identity rows by either path",
		async (document, name) => {
			const reads = await readsOf(document);
			const { published, today } = sides(document, name);
			const byDocument = classifyDeployment({
				reads,
				today,
				published: { kind: "document", source: "folded", menus: published },
				transientAsUnreadable: false,
			});
			const byEvidence = classifyDeployment({
				reads,
				today,
				published: { kind: "none", reason: "fold-refused" },
				transientAsUnreadable: false,
			});
			expect(byDocument.pairing).toEqual({
				path: "published-document",
				source: "folded",
			});
			expect(byEvidence.pairing).toEqual({
				path: "evidence",
				reason: "fold-refused",
			});
			expect(byEvidence.identities).toEqual(byDocument.identities);
			expect(byDocument.unpaired).toEqual([]);
		},
	);

	it("pairs the twins by the published document, and by evidence pairs neither and names both", async () => {
		const reads = await readsOf("targeted-label-sort");
		const { published, today } = sides("targeted-label-sort", "twin-moved");
		const twins = today.flatMap((menu) => menu.forms.map((form) => form.uuid));
		const byDocument = classifyDeployment({
			reads,
			today,
			published: { kind: "document", source: "folded", menus: published },
			transientAsUnreadable: false,
		});
		const byEvidence = classifyDeployment({
			reads,
			today,
			published: { kind: "none", reason: "fold-refused" },
			transientAsUnreadable: false,
		});
		const formRows = (rows: typeof byDocument.identities) =>
			rows
				.filter((row) => row.entityKind === "form")
				.map((row) => row.novaEntityUuid)
				.sort();
		expect(formRows(byDocument.identities)).toEqual([...twins].sort());
		expect(byDocument.unpaired).toEqual([]);
		expect(formRows(byEvidence.identities)).toEqual([]);
		expect(
			byEvidence.unpaired
				.filter((entity) => entity.kind === "form")
				.map((entity) => entity.uuid)
				.sort(),
		).toEqual([...twins].sort());
		const digestOf = (identities: typeof byDocument.identities) =>
			cutoverPlanDigest({
				format: PLAN_FORMAT,
				apps: [app({ deployments: [deployment({ identities })] })],
				lookupTagRenames: [],
				projectBlockers: [],
			});
		expect(digestOf(byDocument.identities)).not.toBe(
			digestOf(byEvidence.identities),
		);
	});
});
