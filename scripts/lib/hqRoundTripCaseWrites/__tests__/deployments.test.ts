/**
 * Step 17, each live deployment's lines (part 09 §9), over CommCare HQ's
 * own reads of what Nova published before step 5.
 *
 * Each test starts from a migration witness's pre-step fixture, its HQ read
 * as the readable baseline and its migrated spec with every hold taken off
 * as the target, runs the placement step as the transform does, and reads
 * the lines the deployment-lines step selects over what that step left.
 *
 * The plausible failures: a line on a deployment whose next publish moves
 * nothing (a block the head still writes counted as moved, a guard block
 * read as gone), a move whose cause names the wrong change, a cause listed
 * out of order, an attachment line where HQ never received a file, and a
 * next-publish line asking what the last publish already confirmed.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, proseText, type Uuid } from "@/lib/domain";
import type {
	DeploymentNoticeEntry,
	MigrationNoticeEntry,
} from "@/lib/notices/migrationNotice";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { targetedUuid } from "@/proof/targeted/build";
import {
	migrationAttachment,
	migrationCaseWrites,
	migrationExtensionChildren,
	migrationGroupsPreloads,
	migrationQueryRepeats,
	migrationRepeatCounts,
} from "@/proof/targeted/documents/migrations";
import { type DeploymentLinesInput, deploymentLines } from "../deployments";
import { todaysPlacements } from "../frozen/todaysPlacements";
import { repeatCountNodeRemoved } from "../notice";
import type { RawDocument } from "../oldShape";
import { placements, readBaseline } from "../placements";
import type { LiftedFacts, PublishedDeployment } from "../types";
import { rawFixture } from "./rawFixture";

const WITNESSES: Readonly<Record<string, () => CorpusDocument>> = {
	"targeted-migration-case-writes": migrationCaseWrites,
	"targeted-migration-extension-children": migrationExtensionChildren,
	"targeted-migration-query-repeats": migrationQueryRepeats,
	"targeted-migration-groups-preloads": migrationGroupsPreloads,
	"targeted-migration-attachment": migrationAttachment,
	"targeted-migration-repeat-counts": migrationRepeatCounts,
};

const DEPLOYMENT = "0b6c6a5e-1111-4a5e-9c1e-000000000001";
const OTHER = "0b6c6a5e-1111-4a5e-9c1e-000000000002";

/** The witness's migrated document with every hold taken off. */
function target(id: string): BlueprintDoc {
	const build = WITNESSES[id];
	if (build === undefined) throw new Error(`No witness ${id}.`);
	return produce(hydratePersistedBlueprint(build().doc), (draft) => {
		for (const form of Object.values(draft.forms)) {
			delete form.ownClosePlacement;
			for (const operation of form.caseOperations ?? [])
				delete operation.placement;
		}
		for (const field of Object.values(draft.fields))
			if (field.kind === "repeat" && field.repeat_mode === "query_bound")
				delete field.placement;
		for (const module of Object.values(draft.modules)) delete module.heldKind;
	});
}

function readableBaseline(id: string): PublishedDeployment["baseline"] {
	const response = JSON.parse(
		readFileSync(
			new URL(
				`../../../../proof/hq-reads/${id}/app-source.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { body: string };
	const normalized = normalizeHqAppSource(JSON.parse(response.body));
	if ("malformed" in normalized) throw new Error(normalized.malformed);
	return readBaseline({
		origin: "push",
		source_gzip: gzipSync(Buffer.from(normalized.text, "utf8")),
		source_digest: normalized.digest,
		observed_at: new Date("2026-10-01T00:00:00.000Z"),
	});
}

function published(
	baseline: PublishedDeployment["baseline"],
	deploymentId = DEPLOYMENT,
): PublishedDeployment {
	return {
		deploymentId,
		server: "production",
		domain: "nova-space",
		baseline,
		overrides: [],
		pushedRevision: null,
	};
}

const UNREAD = { kind: "unknown", why: "unread" } as const;

interface Run {
	readonly id: string;
	readonly baseline?: PublishedDeployment["baseline"];
	readonly target?: BlueprintDoc;
	readonly raw?: RawDocument;
	readonly facts?: Partial<
		Pick<LiftedFacts, "attachmentFields" | "fieldWrites">
	>;
	readonly documentNotice?: readonly MigrationNoticeEntry[];
	/** Live deployments beyond the published one, published nowhere. */
	readonly liveOnly?: readonly string[];
	/** A change to the document the placement step leaves. */
	readonly after?: (doc: BlueprintDoc) => BlueprintDoc;
}

/** The placement step, then the lines, as the transform runs them. */
function lines(run: Run) {
	const raw = run.raw ?? rawFixture(run.id);
	const deployment = published(run.baseline ?? readableBaseline(run.id));
	const step = placements({
		raw,
		target: run.target ?? target(run.id),
		facts: { todaysPlacements: todaysPlacements(raw) },
		deployments: [deployment],
		mutationSeq: 1,
	});
	expect(step.blockers).toEqual([]);
	const input: DeploymentLinesInput = {
		raw,
		target: run.after === undefined ? step.target : run.after(step.target),
		facts: {
			todaysPlacements: todaysPlacements(raw),
			attachmentFields: run.facts?.attachmentFields ?? new Set(),
			fieldWrites: run.facts?.fieldWrites ?? new Map(),
		},
		units: step.units,
		live: [
			deployment,
			...(run.liveOnly ?? []).map((deploymentId) => ({
				deploymentId,
				server: "production" as const,
				domain: "other-space",
			})),
		],
		published: [deployment],
		documentNotice: run.documentNotice ?? [],
	};
	return deploymentLines(input);
}

function reasons(notice: readonly MigrationNoticeEntry[]): string[] {
	return notice.map((entry) => entry.reason);
}

function line(
	notice: readonly MigrationNoticeEntry[],
	reason: DeploymentNoticeEntry["reason"],
): DeploymentNoticeEntry | undefined {
	return notice.find(
		(entry): entry is DeploymentNoticeEntry =>
			entry.kind === "deployment" && entry.reason === reason,
	);
}

describe("a deployment whose next publish moves nothing", () => {
	it.each([
		"targeted-migration-case-writes",
		"targeted-migration-groups-preloads",
	])("gets no line where %s's published read carries every unit", (id) => {
		const result = lines({ id });
		expect(result.pathMoves).toEqual([]);
		expect(result.notice).toEqual([]);
	});
});

describe("deep-links-need-republish", () => {
	it("is on every live deployment of an app with entry points, published or not", () => {
		const id = "targeted-migration-groups-preloads";
		const linked = produce(target(id), (draft) => {
			const [moduleUuid] = draft.moduleOrder;
			if (moduleUuid === undefined) return;
			draft.modules[moduleUuid].entryPoint = {
				uuid: "5d0e6f2a-3b4c-5d6e-8f90-a1b2c3d4e5f7" as Uuid,
				id: "checks",
			};
		});
		const result = lines({ id, target: linked, liveOnly: [OTHER] });
		expect(
			result.notice.map((entry) =>
				entry.kind === "deployment"
					? [entry.reason, entry.deployment.deploymentId]
					: [],
			),
		).toEqual([
			["deep-links-need-republish", DEPLOYMENT],
			["deep-links-need-republish", OTHER],
		]);
	});
});

describe("placements-kept-unread", () => {
	it("is on a published deployment whose baseline is unknown, and nowhere else", () => {
		const id = "targeted-migration-groups-preloads";
		expect(reasons(lines({ id, baseline: UNREAD }).notice)).toEqual([
			"placements-kept-unread",
		]);
		expect(
			reasons(
				lines({ id, baseline: { kind: "unknown", why: "absent" } }).notice,
			),
		).toEqual(["placements-kept-unread"]);
		expect(reasons(lines({ id }).notice)).toEqual([]);
		expect(reasons(lines({ id, baseline: { kind: "shell" } }).notice)).toEqual(
			[],
		);
	});
});

describe("form-data-paths-move", () => {
	it("names the renumbered child, the extension's inert subcase and the menu made advanced", () => {
		const id = "targeted-migration-extension-children";
		const result = lines({ id });
		expect(result.pathMoves).toEqual([
			{
				deploymentId: DEPLOYMENT,
				forms: 2,
				causes: [
					"subcase-renumbered",
					"extension-case-moved",
					"module-made-advanced",
				],
			},
		]);
		expect(line(result.notice, "form-data-paths-move")?.detail).toEqual({
			forms: "2",
			causes: "subcase-renumbered,extension-case-moved,module-made-advanced",
		});
	});

	it("names the same classes where the baseline is unknown", () => {
		const id = "targeted-migration-extension-children";
		const result = lines({ id, baseline: UNREAD });
		expect(result.pathMoves[0]?.causes).toEqual([
			"subcase-renumbered",
			"extension-case-moved",
			"module-made-advanced",
		]);
		expect(reasons(result.notice)).toEqual([
			"placements-kept-unread",
			"form-data-paths-move",
		]);
	});

	it.each([
		["readable", undefined],
		["unknown", UNREAD],
	] as const)(
		"names query repeats moved to the count placement on a %s baseline",
		(_kind, baseline) => {
			const result = lines({
				id: "targeted-migration-query-repeats",
				baseline,
			});
			expect(result.pathMoves).toEqual([
				{
					deploymentId: DEPLOYMENT,
					forms: 1,
					causes: ["repeat-rows-follow-query"],
				},
			]);
		},
	);

	it("names a count node that leaves the wire", () => {
		const id = "targeted-migration-repeat-counts";
		const visits = targetedUuid(id, "visits");
		const result = lines({
			id,
			documentNotice: [
				repeatCountNodeRemoved(
					{ uuid: visits, name: "visits" },
					{ form: "Counted rows", hidden: "planned" },
				),
			],
		});
		expect(result.pathMoves).toEqual([
			{ deploymentId: DEPLOYMENT, forms: 1, causes: ["count-node-removed"] },
		]);
		expect(lines({ id }).pathMoves).toEqual([]);
	});

	it("names a registration that changes its case before creating it", () => {
		const id = "targeted-migration-case-writes";
		const changed = produce(target(id), (draft) => {
			const register = Object.values(draft.forms).find(
				(form) => form.type === "registration",
			);
			const own = register?.caseOperations?.find(
				(operation) => operation.action === "own",
			);
			if (register === undefined || own === undefined) return;
			register.caseOperations?.push({
				uuid: "6a3f0d1e-2c4b-5d6e-8f90-a1b2c3d4e5f6" as Uuid,
				id: "note_new_household",
				action: "update",
				caseType: "household",
				target: { kind: "op", opUuid: own.uuid },
				writes: [
					{
						property: "village",
						value: { kind: "term", term: { kind: "literal", value: "x" } },
					},
				],
			} as never);
		});
		for (const baseline of [undefined, UNREAD]) {
			const result = lines({ id, target: changed, baseline });
			expect(result.pathMoves[0]?.causes).toContain(
				"case-changed-before-create",
			);
		}
	});

	it("names the own close of a form whose closing operations all wrote", () => {
		const id = "targeted-migration-case-writes";
		const raw = structuredClone(rawFixture(id)) as unknown as {
			forms: Record<string, { caseOperations?: Record<string, unknown>[] }>;
		};
		const discharge = targetedUuid(id, "discharge");
		for (const operation of raw.forms[discharge]?.caseOperations ?? [])
			if (operation.action === "close")
				operation.writes = [
					{
						property: "village",
						value: { kind: "term", term: { kind: "literal", value: "gone" } },
					},
				];
		const result = lines({ id, raw: raw as unknown as RawDocument });
		expect(result.pathMoves[0]?.causes).toContain("own-close-moved");
	});

	it("names a block whose question was renamed since the push as simplified", () => {
		const id = "targeted-migration-case-writes";
		const arrivals = targetedUuid(id, "arrivals");
		const renamed = produce(target(id), (draft) => {
			draft.fields[arrivals].id = "arrived";
		});
		const result = lines({ id, target: renamed });
		expect(result.pathMoves).toEqual([
			{ deploymentId: DEPLOYMENT, forms: 1, causes: ["placement-simplified"] },
		]);
		expect(line(result.notice, "form-data-paths-move")?.detail).toEqual({
			forms: "1",
			causes: "placement-simplified",
		});
	});
});

describe("case-attachments-stop", () => {
	const id = "targeted-migration-attachment";
	const form = targetedUuid(id, "photo-form");
	const photo = targetedUuid(id, "photo");
	const scan = targetedUuid(id, "scan");
	const wrote = (fieldUuid: Uuid, property: string) => ({
		attachmentFields: new Set([fieldUuid]),
		fieldWrites: new Map([
			[form, [{ fieldUuid, caseType: "patient", property, capture: true }]],
		]),
	});

	it("is on a deployment whose read writes a capture's property from the question itself", () => {
		const result = lines({ id, facts: wrote(photo, "photo") });
		expect(line(result.notice, "case-attachments-stop")?.detail).toEqual({
			properties: "1",
		});
	});

	it("is absent where the read writes that property from a link", () => {
		const result = lines({ id, facts: wrote(scan, "scan") });
		expect(line(result.notice, "case-attachments-stop")).toBeUndefined();
	});

	it("is on a deployment whose baseline is unknown, counting every such property", () => {
		const result = lines({ id, baseline: UNREAD, facts: wrote(scan, "scan") });
		expect(line(result.notice, "case-attachments-stop")?.detail).toEqual({
			properties: "1",
		});
		expect(
			line(lines({ id, baseline: UNREAD }).notice, "case-attachments-stop"),
		).toBeUndefined();
	});
});

describe("next-publish-asks-more", () => {
	it("asks for CommCare Supply off where a form names the session's supply point", () => {
		const id = "targeted-migration-groups-preloads";
		const supply = produce(target(id), (draft) => {
			const field = Object.values(draft.fields).find(
				(candidate) => candidate.kind === "text",
			);
			if (field !== undefined && "label" in field)
				field.label = proseText(
					"instance('commcaresession')/session/data/supply_point_id",
				);
		});
		const result = lines({ id, target: supply });
		expect(line(result.notice, "next-publish-asks-more")?.detail).toEqual({
			settings: "commtrack-off",
		});
	});

	it("asks for links between cases of the same type only where none is held", () => {
		const id = "targeted-migration-case-writes";
		const head = targetedUuid(id, "register");
		const sameType = produce(target(id), (draft) => {
			for (const operation of draft.forms[head]?.caseOperations ?? [])
				if (operation.action === "create" && operation.caseType === "head") {
					operation.caseType = "household";
					for (const link of operation.links ?? [])
						link.targetType = "household";
				}
		});
		// Unheld, the next publish puts it in a basic subcase and checks the
		// project space.
		const unheld = lines({ id, target: sameType });
		expect(line(unheld.notice, "next-publish-asks-more")?.detail).toEqual({
			capabilities: "same-type-child-links",
		});
		// Held there, its last publish already sent the link.
		const held = lines({
			id,
			target: sameType,
			after: (doc) =>
				produce(doc, (draft) => {
					for (const operation of draft.forms[head]?.caseOperations ?? [])
						if (
							operation.action === "create" &&
							operation.caseType === "household"
						)
							operation.placement = {
								kind: "basic",
								slot: "subcase",
								index: 0,
							};
				}),
		});
		expect(line(held.notice, "next-publish-asks-more")).toBeUndefined();
	});

	it("asks for Save to Case blocks where none of today's placements needed one", () => {
		const id = "targeted-migration-groups-preloads";
		const check = targetedUuid(id, "check");
		const withBlock = produce(target(id), (draft) => {
			draft.forms[check]?.caseOperations?.push({
				uuid: "7b4a1e2f-3c5d-5e6f-9a01-b2c3d4e5f6a7" as Uuid,
				id: "flag_checked",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: {
					kind: "term",
					term: { kind: "literal", value: true },
				},
				writes: [
					{
						property: "weight",
						value: { kind: "term", term: { kind: "literal", value: "1" } },
					},
				],
			} as never);
		});
		const result = lines({
			id,
			target: withBlock,
			baseline: { kind: "shell" },
		});
		expect(line(result.notice, "next-publish-asks-more")?.detail).toEqual({
			planFeatures: "advanced-case-actions",
		});
		// Today's placements already put a unit in a Save to Case block in
		// this app, so its last publish already asked.
		expect(
			line(
				lines({
					id: "targeted-migration-case-writes",
					baseline: { kind: "shell" },
				}).notice,
				"next-publish-asks-more",
			),
		).toBeUndefined();
	});

	it("is absent where the target needs nothing new", () => {
		expect(
			line(
				lines({ id: "targeted-migration-groups-preloads" }).notice,
				"next-publish-asks-more",
			),
		).toBeUndefined();
	});
});
