/**
 * Step 14, the placements a published app keeps (part 09 §8), over CommCare
 * HQ's own reads of what Nova published before step 5.
 *
 * Each migration witness's pre-step fixture is the app as `main` stored it,
 * and `proof/hq-reads/<witness>/app-source.json` is the source CommCare HQ
 * served after Nova published it, so it stands for a deployment's readable
 * baseline exactly as a publish stored one (`normalizeHqAppSource`, gzipped,
 * its digest beside it). The target is the witness's migrated spec
 * (`proof/targeted/documents/migrations.ts`), every hold taken off it, which
 * is the document the steps before this one leave; the spec's holds are the
 * cutover's, so the step must write exactly those.
 *
 * The plausible failures: a unit held where HQ holds no block for it (a
 * question renamed since the push, a deployment that carries nothing), a
 * unit of section 8.5 held where its old place no longer exists, a baseline
 * whose bytes no longer verify read as one that carries nothing, a form
 * looked up by the derived `xmlns` where the deployment holds another, and
 * a hold the head's emission writes somewhere else.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { derivedFormXmlns } from "@/lib/commcare/wireIdentity";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import type { CorpusDocument } from "@/proof/corpus/documents";
import {
	migrationAttachment,
	migrationCaseWrites,
	migrationExtensionChildren,
	migrationFormLinks,
	migrationGroupsPreloads,
	migrationQueryRepeats,
	migrationRepeatCounts,
	migrationSearchWorkflow,
} from "@/proof/targeted/documents/migrations";
import { todaysPlacements } from "../frozen/todaysPlacements";
import {
	type BaselineRow,
	type PlacementInput,
	placements,
	readBaseline,
	readUnits,
} from "../placements";
import type { PublishedDeployment, TodaysPlacement } from "../types";
import { rawFixture } from "./rawFixture";

const WITNESSES: Readonly<Record<string, () => CorpusDocument>> = {
	"targeted-migration-case-writes": migrationCaseWrites,
	"targeted-migration-extension-children": migrationExtensionChildren,
	"targeted-migration-query-repeats": migrationQueryRepeats,
	"targeted-migration-groups-preloads": migrationGroupsPreloads,
	"targeted-migration-search-workflow": migrationSearchWorkflow,
	"targeted-migration-form-links": migrationFormLinks,
	"targeted-migration-attachment": migrationAttachment,
	"targeted-migration-repeat-counts": migrationRepeatCounts,
};

/** The witnesses whose spec writes the cutover's holds (the others hold
 *  only what a later publish records). */
const HOLDING = [
	"targeted-migration-case-writes",
	"targeted-migration-extension-children",
	"targeted-migration-query-repeats",
	"targeted-migration-groups-preloads",
] as const;

const witnessDocs = new Map<string, BlueprintDoc>();

/** The witness's migrated document, holds and all. */
function witness(id: string): BlueprintDoc {
	let doc = witnessDocs.get(id);
	if (doc === undefined) {
		const build = WITNESSES[id];
		if (build === undefined) throw new Error(`No witness ${id}.`);
		doc = hydratePersistedBlueprint(build().doc);
		witnessDocs.set(id, doc);
	}
	return doc;
}

/** `doc` holding nothing: the document the steps before 14 leave. */
function unheld(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
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

/** CommCare HQ's read of the witness, as the body it answered. */
function hqRead(id: string): Record<string, unknown> {
	const response = JSON.parse(
		readFileSync(
			new URL(
				`../../../../proof/hq-reads/${id}/app-source.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { body: string };
	return JSON.parse(response.body) as Record<string, unknown>;
}

/** A baseline row of origin `push` holding `source`, as a publish stores it. */
function pushRow(source: unknown): BaselineRow {
	const normalized = normalizeHqAppSource(source);
	if ("malformed" in normalized)
		throw new Error(`The read is not an application: ${normalized.malformed}`);
	return {
		origin: "push",
		source_gzip: gzipSync(Buffer.from(normalized.text, "utf8")),
		source_digest: normalized.digest,
		observed_at: new Date("2026-10-01T00:00:00.000Z"),
	};
}

function deployment(
	baseline: PublishedDeployment["baseline"],
	fields: Partial<PublishedDeployment> = {},
): PublishedDeployment {
	return {
		deploymentId: "0b6c6a5e-1111-4a5e-9c1e-000000000001",
		server: "production",
		domain: "nova-space",
		baseline,
		overrides: [],
		pushedRevision: null,
		...fields,
	};
}

function readable(id: string, fields: Partial<PublishedDeployment> = {}) {
	return deployment(readBaseline(pushRow(hqRead(id))), fields);
}

function input(
	id: string,
	deployments: readonly PublishedDeployment[],
	fields: Partial<PlacementInput> = {},
): PlacementInput {
	const raw = rawFixture(id);
	return {
		raw,
		target: unheld(witness(id)),
		facts: { todaysPlacements: todaysPlacements(raw) },
		deployments,
		mutationSeq: 7,
		...fields,
	};
}

/** Every hold of a document, keyed by target, with its placement. */
function holdsOf(doc: BlueprintDoc): Record<string, unknown> {
	return Object.fromEntries(
		[...readPlacementHolds(doc)].map(([key, hold]) => [key, hold.placement]),
	);
}

describe("reading a stored baseline", () => {
	const source = hqRead("targeted-migration-case-writes");

	it("reads a push or cutover baseline whose bytes verify as readable", () => {
		const row = pushRow(source);
		for (const origin of ["push", "cutover"]) {
			const baseline = readBaseline({ ...row, origin });
			expect(baseline.kind).toBe("readable");
			if (baseline.kind !== "readable") continue;
			expect(baseline.sourceDigest).toBe(row.source_digest);
			expect(baseline.observedAt).toBe("2026-10-01T00:00:00.000Z");
			expect(canonicalJsonText(baseline.source)).toBe(
				canonicalJsonText(
					(normalizeHqAppSource(source) as { normalized: unknown }).normalized,
				),
			);
		}
	});

	it("reads an empty app as a shell, and an unread or missing row as unknown", () => {
		expect(readBaseline({ ...pushRow(source), origin: "create" })).toEqual({
			kind: "shell",
		});
		expect(
			readBaseline({
				origin: "unread",
				source_gzip: null,
				source_digest: null,
				observed_at: new Date(0),
			}),
		).toEqual({ kind: "unknown", why: "unread" });
		expect(readBaseline(undefined)).toEqual({ kind: "unknown", why: "absent" });
		expect(readBaseline(null)).toEqual({ kind: "unknown", why: "absent" });
	});

	it("reads bytes that fail gunzip, the digest or the parse as unreadable", () => {
		const row = pushRow(source);
		expect(
			readBaseline({ ...row, source_gzip: Buffer.from("not gzip") }),
		).toEqual({ kind: "unreadable", why: "gunzip" });
		expect(readBaseline({ ...row, source_digest: "0".repeat(64) })).toEqual({
			kind: "unreadable",
			why: "digest",
		});
		const text = Buffer.from("{ not json", "utf8");
		expect(
			readBaseline({
				...row,
				source_gzip: gzipSync(text),
				source_digest: createHash("sha256").update(text).digest("hex"),
			}),
		).toEqual({ kind: "unreadable", why: "parse" });
	});

	it("refuses an origin Nova never writes", () => {
		expect(() =>
			readBaseline({ ...pushRow(source), origin: "guessed" }),
		).toThrow(/origin "guessed"/);
	});
});

describe("the placement step over HQ's reads", () => {
	it.each(HOLDING)(
		"holds every unit of %s at the placement its published read carries",
		(id) => {
			const result = placements(input(id, [readable(id)]));
			expect(result.blockers).toEqual([]);
			expect(holdsOf(result.target)).toEqual(holdsOf(witness(id)));
		},
	);

	it.each(Object.keys(WITNESSES))(
		"holds each unit of %s at today's placement or not at all",
		(id) => {
			const step = input(id, [readable(id)]);
			const result = placements(step);
			expect(result.blockers).toEqual([]);
			const today = new Map(
				[...step.facts.todaysPlacements.values()].map(
					(placement): [string, TodaysPlacement] => [
						`${placement.formUuid}|${placement.unit}`,
						placement,
					],
				),
			);
			for (const held of result.held) {
				const formUuid =
					held.target === "query-repeat"
						? [...today.values()].find(
								(placement) => placement.unit === held.unit,
							)?.formUuid
						: held.formUuid;
				const placement = today.get(`${formUuid}|${held.unit}`)?.placement;
				if (held.unit.startsWith("child:")) continue; // §8.5's renumbering
				if (held.target === "own-close" && placement === undefined) continue;
				expect(held.source).toBe("carried");
				expect(
					held.placement === "model-iteration"
						? "model-iteration"
						: held.placement,
				).toEqual(
					held.target === "own-close" &&
						placement !== undefined &&
						placement !== "model-iteration"
						? {
								kind: "save-to-case",
								path: (placement as { path: unknown }).path,
							}
						: placement,
				);
			}
		},
	);

	it("writes holds through one holdPlacements, and a second run writes none", () => {
		const id = "targeted-migration-case-writes";
		const first = placements(input(id, [readable(id)]));
		expect(first.changes.length).toBeGreaterThan(0);
		const second = placements(
			input(id, [readable(id)], { target: first.target }),
		);
		expect(second.blockers).toEqual([]);
		expect(second.changes).toEqual([]);
		expect(second.target).toBe(first.target);
		expect(second.held).toEqual(first.held);
	});

	it("counts holds by target, by source and by unheld class", () => {
		const id = "targeted-migration-extension-children";
		const result = placements(input(id, [readable(id)]));
		expect(result.counts.byTarget["case-operation"]).toBe(result.held.length);
		expect(result.counts.bySource.carried).toBe(result.held.length);
		expect(result.counts.unheld["module-made-advanced"]).toBeGreaterThan(0);
	});

	it("leaves a unit unheld once a question on its path is renamed since the push", () => {
		const id = "targeted-migration-case-writes";
		const step = input(id, [readable(id)]);
		const arrivals = Object.values(step.target.fields).find(
			(field) => field.id === "arrivals",
		);
		if (arrivals === undefined) throw new Error("No arrivals repeat.");
		const renamed = produce(step.target, (draft) => {
			draft.fields[arrivals.uuid].id = "arrived";
		});
		const result = placements({ ...step, target: renamed });
		expect(result.blockers).toEqual([]);
		const held = new Set(result.held.map((unit) => unit.unit));
		const addArrival = [...step.facts.todaysPlacements.values()].find(
			(placement) =>
				placement.placement !== "model-iteration" &&
				placement.placement.kind === "save-to-case" &&
				placement.placement.repeat === arrivals.uuid,
		);
		expect(addArrival).toBeDefined();
		expect(held.has(addArrival?.unit ?? "operation:")).toBe(false);
		expect(result.counts.unheld["not-carried"]).toBe(1);
		// Every other unit is still held where HQ holds it.
		expect(result.held.length).toBe(placements(step).held.length - 1);
	});

	it("holds nothing for an unpublished app, nor for a shell", () => {
		const id = "targeted-migration-case-writes";
		for (const deployments of [[], [deployment({ kind: "shell" })]]) {
			const result = placements(input(id, deployments));
			expect(result.blockers).toEqual([]);
			expect(result.held).toEqual([]);
			expect(result.changes).toEqual([]);
			expect(holdsOf(result.target)).toEqual({});
		}
	});

	it.each(["unread", "absent"] as const)(
		"keeps every unit it can express where the baseline is %s",
		(why) => {
			const id = "targeted-migration-case-writes";
			const result = placements(
				input(id, [deployment({ kind: "unknown", why })]),
			);
			expect(result.blockers).toEqual([]);
			expect(
				result.held.every((unit) => unit.source === "unknown-baseline"),
			).toBe(true);
			// The readable baseline carries every unit, so the unknown one holds
			// the same.
			expect(holdsOf(result.target)).toEqual(holdsOf(witness(id)));
		},
	);

	it.each(["gunzip", "digest", "parse"] as const)(
		"stops with baseline-unreadable on a baseline that fails its %s",
		(why) => {
			const id = "targeted-migration-case-writes";
			const result = placements(
				input(id, [readable(id), deployment({ kind: "unreadable", why })]),
			);
			expect(result.blockers).toEqual([
				expect.objectContaining({
					code: "baseline-unreadable",
					count: 1,
					findingCodes: [`baseline-unreadable:${why}`],
				}),
			]);
			expect(result.held).toEqual([]);
			expect(holdsOf(result.target)).toEqual({});
		},
	);

	it("holds what one of two deployments carries, the other carrying nothing", () => {
		const id = "targeted-migration-case-writes";
		const carrying = readable(id);
		const other = deployment(
			readBaseline(pushRow(hqRead("targeted-migration-attachment"))),
			{ deploymentId: "0b6c6a5e-1111-4a5e-9c1e-000000000002" },
		);
		const alone = placements(input(id, [other]));
		expect(alone.held).toEqual([]);
		expect(alone.counts.unheld["not-carried"]).toBeGreaterThan(0);
		const both = placements(input(id, [other, carrying]));
		expect(holdsOf(both.target)).toEqual(holdsOf(witness(id)));
	});

	it("reads a deployment's form under the xmlns its identity overrides give it", () => {
		const id = "targeted-migration-groups-preloads";
		const target = unheld(witness(id));
		const [formUuid] = Object.keys(target.forms) as Uuid[];
		const source = hqRead(id) as {
			modules: { forms: { xmlns: string }[] }[];
		};
		const moved = structuredClone(source);
		const recorded = "http://openrosa.org/formdesigner/RECORDED-BY-HQ";
		for (const module of moved.modules)
			for (const form of module.forms)
				if (form.xmlns === derivedFormXmlns(formUuid)) form.xmlns = recorded;
		const underDerived = placements(
			input(id, [deployment(readBaseline(pushRow(moved)))]),
		);
		expect(underDerived.held).toEqual([]);
		const underOverride = placements(
			input(id, [
				deployment(readBaseline(pushRow(moved)), {
					overrides: [
						{
							entityKind: "form",
							novaEntityUuid: formUuid,
							uniqueId: null,
							xmlns: recorded,
						},
					],
				}),
			]),
		);
		expect(holdsOf(underOverride.target)).toEqual(holdsOf(witness(id)));
	});
});

describe("the units section 8.5 never holds", () => {
	it("holds no unit of a menu made advanced and no create a link carries", () => {
		const id = "targeted-migration-extension-children";
		const step = input(id, [readable(id)]);
		const units = readUnits(step);
		const classes = units.map((unit) => unit.never);
		expect(classes).toContain("module-made-advanced");
		const result = placements(step);
		const advanced = new Set(
			units
				.filter((unit) => unit.never === "module-made-advanced")
				.map((unit) => unit.formUuid),
		);
		expect(
			result.held.some(
				(unit) => unit.target !== "query-repeat" && advanced.has(unit.formUuid),
			),
		).toBe(false);
		// The same document read as if its link carried Register's episode.
		const register = units.find((unit) => unit.unit.startsWith("extension:"));
		if (register?.subject?.target !== "case-operation")
			throw new Error("No extension create.");
		const carried = placements({
			...step,
			carriedCreates: new Map([
				[register.formUuid, new Set([register.subject.operationUuid])],
			]),
		});
		expect(carried.held.some((unit) => unit.unit === register.unit)).toBe(
			false,
		);
		expect(carried.counts.unheld["carried-create"]).toBe(1);
	});

	it("holds a child main numbered past an inert extension subcase at its new index", () => {
		const id = "targeted-migration-extension-children";
		const result = placements(input(id, [readable(id)]));
		const child = result.held.find((unit) => unit.unit.startsWith("child:"));
		expect(child?.placement).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 0,
		});
		// Where the baseline is unknown, nothing says HQ held it at the old
		// index, so it takes the head's index unheld.
		const unknown = placements(
			input(id, [deployment({ kind: "unknown", why: "unread" })]),
		);
		expect(unknown.held.some((unit) => unit.unit.startsWith("child:"))).toBe(
			false,
		);
		expect(unknown.counts.unheld["subcase-renumbered"]).toBe(1);
	});

	it("leaves a query repeat whose rule gives the count placement to it", () => {
		const id = "targeted-migration-query-repeats";
		const result = placements(
			input(id, [deployment({ kind: "unknown", why: "unread" })]),
		);
		expect(result.counts.unheld["query-repeat-count"]).toBe(2);
		expect(result.counts.byTarget["query-repeat"]).toBe(1);
	});

	it("leaves the own arm of a registration that changes its case before creating it", () => {
		const id = "targeted-migration-case-writes";
		const step = input(id, [readable(id)]);
		const register = Object.values(step.target.forms).find(
			(form) => form.type === "registration",
		);
		if (register === undefined) throw new Error("No registration.");
		const own = register.caseOperations?.find(
			(operation) => operation.action === "own",
		);
		if (own === undefined) throw new Error("No own arm.");
		// An update of the new case, which the registration makes before HQ's
		// basic open action would create it (part 01 C11).
		const changed = produce(step.target, (draft) => {
			draft.forms[register.uuid].caseOperations?.push({
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
		const units = readUnits({ ...step, target: changed });
		const ownUnit = units.find(
			(unit) => unit.formUuid === register.uuid && unit.unit === "own",
		);
		expect(ownUnit?.never).toBe("case-changed-before-create");
	});

	it("leaves the own close of a form whose closing operations all wrote", () => {
		const id = "targeted-migration-case-writes";
		const step = input(id, [readable(id)]);
		const discharge = Object.values(step.target.forms).find(
			(form) => form.name === "Discharge",
		);
		if (discharge === undefined) throw new Error("No Discharge.");
		// The raw close operation, given a write, which C9 keeps as an update.
		const raw = structuredClone(step.raw) as unknown as {
			forms: Record<string, { caseOperations?: Record<string, unknown>[] }>;
		};
		for (const operation of raw.forms[discharge.uuid]?.caseOperations ?? [])
			if (operation.action === "close")
				operation.writes = [
					{
						property: "village",
						value: { kind: "term", term: { kind: "literal", value: "gone" } },
					},
				];
		const units = readUnits({ ...step, raw: raw as never });
		expect(
			units.some(
				(unit) => unit.formUuid === discharge.uuid && unit.unit === "own-close",
			),
		).toBe(false);
	});
});

describe("the verification and the frozen check", () => {
	it("refuses with placement-path-mismatch a hold the head cannot express", () => {
		const id = "targeted-migration-case-writes";
		const step = input(id, [readable(id)]);
		const visit = Object.values(step.target.forms).find(
			(form) => form.name === "Visit",
		);
		if (visit === undefined) throw new Error("No Visit.");
		// Today's emission planted as writing Visit's own case as its first
		// basic subcase, a place no own case can take, with a baseline that
		// is unknown, so the unit must be kept there.
		const todays = new Map(step.facts.todaysPlacements);
		const key = `${visit.uuid}|own`;
		const own = todays.get(key);
		if (own === undefined) throw new Error("No own unit.");
		todays.set(key, {
			...own,
			placement: { kind: "basic", slot: "subcase", index: 0 },
		});
		const result = placements({
			...step,
			facts: { todaysPlacements: todays },
			deployments: [deployment({ kind: "unknown", why: "unread" })],
		});
		expect(result.blockers).toEqual([
			expect.objectContaining({
				code: "placement-path-mismatch",
				count: 1,
				findingCodes: [expect.stringMatching(/^HELD_PLACEMENT_INEXPRESSIBLE:/)],
			}),
		]);
		expect(result.held).toEqual([]);
		expect(holdsOf(result.target)).toEqual({});
	});

	it("counts no disagreement over a document unchanged since its push", () => {
		const id = "targeted-migration-case-writes";
		const result = placements(input(id, [readable(id, { pushedRevision: 7 })]));
		expect(result.counts.frozenChecked).toBe(1);
		expect(result.counts.frozenDisagrees).toBe(0);
		// A deployment pushed before the app's last edit is not checked.
		expect(
			placements(input(id, [readable(id, { pushedRevision: 6 })])).counts
				.frozenChecked,
		).toBe(0);
	});

	it("counts the block a planted baseline is missing", () => {
		const id = "targeted-migration-case-writes";
		const source = hqRead(id) as {
			modules: { forms: { actions?: { usercase_update?: unknown } }[] }[];
		};
		const planted = structuredClone(source);
		for (const module of planted.modules)
			for (const form of module.forms)
				if (form.actions?.usercase_update !== undefined)
					form.actions.usercase_update = {
						doc_type: "UpdateCaseAction",
						update: {},
						condition: { type: "never", doc_type: "FormActionCondition" },
					};
		const result = placements(
			input(id, [
				deployment(readBaseline(pushRow(planted)), { pushedRevision: 7 }),
			]),
		);
		expect(result.counts.frozenDisagrees).toBe(1);
		expect(result.frozen).toEqual([
			expect.objectContaining({ side: "unit-not-carried", what: "usercase" }),
		]);
	});
});
