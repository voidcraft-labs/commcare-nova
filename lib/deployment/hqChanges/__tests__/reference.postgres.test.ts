/**
 * The reference document a review of changes made in CommCare HQ measures
 * Nova's own changes against, built from real `app_changes` rows on real
 * Postgres, and `usablePair`, the rule of whether a deployment's baseline and
 * revision can be compared at all.
 *
 * Contract: the reference is the document at the published revision with
 * every server write after it (a hold a publish recorded, a repair a deploy
 * ran, a move of the app to another Project) and what a publish never sends
 * taken from the head; a person's change after the publish is no part of it,
 * and only a repair that applies whole and a move no person's change
 * precedes are. A rename and its rename back cancel, and the members who
 * changed the app are named.
 *
 * Plausible failure: a server's write read as a person's change (every
 * picture after a move listed as Nova's), a person's change carried into the
 * reference as if it had been published, a repair applied in part, the worker
 * setup taken from the published document so a discard would lose it, or a
 * slug renamed in Nova bound to the property CommCare HQ's app does not mean.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { writeHqRoundTripHorizon } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import {
	childCreate,
	OP,
	OWN,
	own,
	placementFixture,
} from "@/lib/commcare/__tests__/placementFixture";
import { placementCandidates } from "@/lib/commcare/placement";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { commitGuardedBatchProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { appendSyntheticBatch, loadApp } from "@/lib/db/apps";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CasePlacement, Form, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { placementMoveOffer } from "../../placementMoves";
import { recordPublishPlacements } from "../../placements";
import { readBackDifferences } from "../../reading/readBack";
import type { AppBaseline } from "../../types";
import { loadReferenceDocument, usablePair } from "../reference";

const h = setupAppStateTestDb("hq_changes_reference_", {
	authSchema: "migrated",
});

const OWNER = "reference-owner";
const COLLEAGUE = "reference-colleague";
const PROJECT = "reference-project";
const OTHER_PROJECT = "reference-other-project";
const VILLAGE = testUuid("reference-village") as Uuid;
const PERSONA = testUuid("reference-persona") as Uuid;
const FORM = testUuid("reference-visit") as Uuid;

/** A clinic whose follow-up saves a note, with a worker property and a persona. */
function clinic(): BlueprintDoc {
	return buildDoc(
		{
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "reference-visit",
							name: "Visit",
							type: "followup",
							fields: [
								f({
									uuid: "reference-note",
									kind: "text",
									id: "note",
									label: "Note",
									caseWrite: { caseType: "patient", property: "note" },
								}),
								f({
									kind: "text",
									id: "home",
									label: "Home",
									default_value: "#user/village",
								}),
							],
						},
					],
				},
			],
		},
		(doc) => {
			doc.userProperties = {
				[VILLAGE]: { uuid: VILLAGE, slug: "village", label: "Village" },
			};
			doc.userPropertyOrder = [VILLAGE];
			doc.personas = {
				[PERSONA]: {
					uuid: PERSONA,
					name: "Asha",
					values: { [VILLAGE]: "north" },
				},
			};
			doc.personaOrder = [PERSONA];
		},
	);
}

/** An app published at its fold baseline: its revision and the document there. */
async function published(): Promise<{
	readonly appId: string;
	readonly revision: number;
	readonly doc: BlueprintDoc;
}> {
	const appId = await h.seedAppWithBlueprint(clinic(), {
		owner: OWNER,
		projectId: PROJECT,
	});
	await h.seedProjectMember(COLLEAGUE, PROJECT, "editor");
	const revision = await writeHqRoundTripHorizon(h.db(), appId, "Clinic");
	return { appId, revision, doc: await headDoc(appId) };
}

async function head(appId: string) {
	const loaded = await loadApp(appId);
	if (loaded === null) throw new Error(`No app ${appId}.`);
	return {
		doc: hydratePersistedBlueprint(loaded.blueprint),
		seq: loaded.mutation_seq,
	};
}

async function headDoc(appId: string): Promise<BlueprintDoc> {
	return (await head(appId)).doc;
}

/** A person's change, committed as an autosave. */
async function edit(
	appId: string,
	mutations: readonly Mutation[],
	actor = OWNER,
	projectId = PROJECT,
) {
	return commitGuardedBatchProposal({
		appId,
		expectedProjectId: projectId,
		batchId: crypto.randomUUID(),
		mutations,
		actorUserId: actor,
		kind: "autosave",
	});
}

/** A repair a deploy ran over the app: its document becomes `target`. */
async function migrate(appId: string, target: BlueprintDoc) {
	const { seq } = await head(appId);
	return appendSyntheticBatch({
		appId,
		expectedBaseSeq: seq,
		targetDoc: toPersistableDoc(target),
		authority: {
			kind: "system",
			actorId: "system:reference-test",
			reason: "A repair a deploy runs",
		},
	});
}

/** Whether Nova holds nothing unpublished: the two documents read alike. */
function readsAlike(reference: BlueprintDoc, now: BlueprintDoc): boolean {
	return (
		readBackDifferences(canonDocument(reference), {
			doc: canonDocument(now),
			choices: null,
		}).length === 0
	);
}

async function reference(appId: string, revision: number) {
	return loadReferenceDocument({
		appId,
		novaRevision: revision,
		head: await head(appId),
	});
}

function okOf(answer: Awaited<ReturnType<typeof reference>>) {
	if (answer.kind !== "ok") throw new Error(`The reference is ${answer.kind}.`);
	return answer;
}

describe("loadReferenceDocument", () => {
	it("is the head itself where the head is the published revision", async () => {
		const { appId, revision, doc } = await published();
		const answer = okOf(await reference(appId, revision));
		expect(toPersistableDoc(answer.doc)).toEqual(toPersistableDoc(doc));
		expect(answer.renamesSince).toEqual([]);
		expect(answer.actors).toEqual([]);
	});

	it("holds a hold a publish recorded after the publish, and Nova then holds nothing unpublished", async () => {
		const { appId, revision, doc } = await published();
		const holds = placementsToHold(doc);
		expect(holds.length).toBeGreaterThan(0);
		const recorded = await recordPublishPlacements({
			scope: { appId, projectId: PROJECT, role: "owner", actorUserId: OWNER },
			expectedHeadSeq: revision,
			holds,
		});
		expect(recorded.kind).toBe("recorded");
		const answer = okOf(await reference(appId, revision));
		const now = await headDoc(appId);
		expect(toPersistableDoc(answer.doc).forms).toEqual(
			toPersistableDoc(now).forms,
		);
		expect(answer.actors).toEqual([]);
		expect(readsAlike(answer.doc, now)).toBe(true);
	});

	it("holds a move a person accepted at a publish after it, and Nova then holds nothing unpublished", async () => {
		/* A follow-up whose own case and child case each sit in a Save to Case
		 * block, which a publish offers to move to Case Management. */
		const unheld = (type: Form["type"]) => [own(), childCreate("kid", type)];
		const block = (operationUuid: Uuid): CasePlacement => {
			const { doc, formUuid } = placementFixture("followup", {
				operations: unheld,
			});
			const found = placementCandidates(doc, formUuid, {
				kind: "operation",
				operationUuid,
			}).find((candidate) => candidate.kind === "save-to-case");
			if (found === undefined)
				throw new Error(
					"The planner offers every operation a Save to Case block.",
				);
			return found;
		};
		const { doc } = placementFixture("followup", {
			operations: (type) => [
				own({ placement: block(OWN) }),
				childCreate("kid", type, { placement: block(OP("kid")) }),
			],
		});
		const appId = await h.seedAppWithBlueprint(doc, {
			owner: OWNER,
			projectId: PROJECT,
		});
		const revision = await writeHqRoundTripHorizon(h.db(), appId, doc.appName);
		const offer = placementMoveOffer(await headDoc(appId), "save-to-case");
		if (offer === null) throw new Error("The publish offers no move.");
		const recorded = await recordPublishPlacements({
			scope: { appId, projectId: PROJECT, role: "owner", actorUserId: OWNER },
			expectedHeadSeq: revision,
			holds: offer.holds,
		});
		expect(recorded.kind).toBe("recorded");
		const answer = okOf(await reference(appId, revision));
		const now = await headDoc(appId);
		expect(toPersistableDoc(answer.doc).forms).toEqual(
			toPersistableDoc(now).forms,
		);
		expect(answer.actors).toEqual([]);
		expect(readsAlike(answer.doc, now)).toBe(true);
	});

	it("holds a repair that applies to the published document", async () => {
		const { appId, revision, doc } = await published();
		const repaired = mutationCommitVerdict(
			doc,
			admitMutationBatch([{ kind: "setAppName", name: "Clinic (repaired)" }]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!repaired.ok) throw new Error("The repair is refused.");
		const migrated = await migrate(appId, repaired.nextDoc);
		expect(migrated.kind).toBe("committed");
		const answer = okOf(await reference(appId, revision));
		expect(answer.doc.appName).toBe("Clinic (repaired)");
		expect(answer.actors).toEqual([]);
	});

	it("answers nova-updated for a repair that does not apply to the published document", async () => {
		const { appId, revision } = await published();
		// A person adds a question after the publish, and a repair then rewrites it: the
		// repair's batch names a question the published document never held.
		const added = testUuid("reference-added") as Uuid;
		await edit(appId, [
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: added,
					id: "added",
					kind: "text",
					label: proseText("Added"),
				},
			},
		] as unknown as Mutation[]);
		const now = await headDoc(appId);
		const repaired = mutationCommitVerdict(
			now,
			admitMutationBatch([
				{
					kind: "updateField",
					uuid: added,
					targetKind: "text",
					patch: { label: proseText("Added, repaired") },
				},
			]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!repaired.ok) throw new Error("The repair is refused.");
		await migrate(appId, repaired.nextDoc);
		expect(await reference(appId, revision)).toEqual({ kind: "nova-updated" });
	});

	it("names no rename where a property was renamed and renamed back, and the members who changed the app", async () => {
		const { appId, revision } = await published();
		const there = { caseType: "patient", from: "note", to: "remark" };
		const back = { caseType: "patient", from: "remark", to: "note" };
		await edit(appId, [{ kind: "renameCaseProperties", renames: [there] }]);
		const once = okOf(await reference(appId, revision));
		expect(once.renamesSince).toEqual([there]);
		await edit(
			appId,
			[{ kind: "renameCaseProperties", renames: [back] }],
			COLLEAGUE,
		);
		const answer = okOf(await reference(appId, revision));
		expect(answer.renamesSince).toEqual([]);
		expect(answer.actors).toEqual([OWNER, COLLEAGUE]);
	});

	it("takes the worker setup and the logo from the head, the name and a slug from the published document", async () => {
		const { appId, revision } = await published();
		const district = testUuid("reference-district") as Uuid;
		await edit(appId, [
			{ kind: "setAppName", name: "Clinic 2" },
			{
				kind: "updateUserProperty",
				uuid: VILLAGE,
				patch: { slug: "home_village", label: "Home village" },
			},
			{
				kind: "addUserProperty",
				property: { uuid: district, slug: "district", label: "District" },
			},
			{ kind: "updatePersona", uuid: PERSONA, patch: { name: "Asha K" } },
		] as unknown as Mutation[]);
		const now = await headDoc(appId);
		const answer = okOf(await reference(appId, revision));
		expect(answer.doc.appName).toBe("Clinic");
		expect(answer.doc.personas).toEqual(now.personas);
		expect(answer.doc.logo).toEqual(now.logo);
		expect(answer.doc.userPropertyOrder).toEqual(now.userPropertyOrder);
		expect(answer.doc.userProperties?.[VILLAGE]).toEqual({
			...now.userProperties?.[VILLAGE],
			slug: "village",
		});
		expect(answer.doc.userProperties?.[district]).toEqual(
			now.userProperties?.[district],
		);
	});

	it("binds a slug two properties hold to the one the published document held", async () => {
		const { appId, revision } = await published();
		const newer = testUuid("reference-newer") as Uuid;
		await edit(appId, [
			{ kind: "updateUserProperty", uuid: VILLAGE, patch: { slug: "home" } },
			{
				kind: "addUserProperty",
				property: { uuid: newer, slug: "village", label: "Village again" },
			},
		] as unknown as Mutation[]);
		const answer = okOf(await reference(appId, revision));
		expect(
			Object.values(answer.doc.userProperties ?? {}).map((one) => one.slug),
		).toEqual(["village", "village"]);
		expect(Object.keys(answer.identityDoc.userProperties ?? {})).toEqual([
			VILLAGE,
		]);
		// The take is made over this document, and the gate refuses it by the property's own
		// finding until the newer property is renamed in Nova.
		const verdict = mutationCommitVerdict(
			answer.doc,
			admitMutationBatch([]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			verdict.ok ? [] : verdict.findings.map((finding) => finding.code),
		).toContain("USER_PROPERTY_SLUG_DUPLICATE");
	});

	it("holds a move to another Project that no person's change precedes, and Nova then holds nothing unpublished", async () => {
		const { appId, revision } = await published();
		await h.seedProjectMember(OWNER, OTHER_PROJECT, "owner");
		await h.moveAppToProject(appId, OTHER_PROJECT, OWNER);
		const answer = okOf(await reference(appId, revision));
		expect(readsAlike(answer.doc, await headDoc(appId))).toBe(true);
		expect(answer.actors).toEqual([]);
	});

	it("answers app-moved for a move that follows a person's change", async () => {
		const { appId, revision } = await published();
		await edit(appId, [{ kind: "setAppName", name: "Clinic 2" }]);
		await h.seedProjectMember(OWNER, OTHER_PROJECT, "owner");
		await h.moveAppToProject(appId, OTHER_PROJECT, OWNER);
		expect(await reference(appId, revision)).toEqual({ kind: "app-moved" });
	});
});

describe("usablePair", () => {
	const source = (
		origin: "create" | "push" | "cutover" | "read" | "changes",
		novaRevision: number | null,
	): AppBaseline => ({
		origin,
		remoteAppId: "hq-app",
		source: {},
		sourceDigest: "digest",
		ownership: {} as Extract<AppBaseline, { origin: "push" }>["ownership"],
		observedAt: "2026-11-15T00:00:00.000Z",
		observedBy: OWNER,
		novaRevision,
		mediaFiles: null,
		sourceBytes: 10,
	});
	const mapping = (pushedRevision: number | null) => ({ pushedRevision });

	it("holds for a push at the mapping's revision, a read and a bring-in of changes", () => {
		expect(usablePair(source("push", 4), mapping(4), 1)).toBe(true);
		expect(usablePair(source("read", 1), mapping(null), 1)).toBe(true);
		expect(usablePair(source("changes", 7), mapping(4), 1)).toBe(true);
	});

	it("does not hold for a baseline that describes no Nova document", () => {
		expect(usablePair(source("create", null), mapping(null), 1)).toBe(false);
		expect(usablePair(source("cutover", null), mapping(3), 1)).toBe(false);
		expect(usablePair(source("cutover", 3), mapping(3), 1)).toBe(false);
		expect(
			usablePair(
				{
					origin: "unread",
					remoteAppId: "hq-app",
					observedAt: "2026-11-15T00:00:00.000Z",
					observedBy: OWNER,
					storedOrigin: "push",
					novaRevision: 3,
					mediaFiles: null,
				},
				mapping(3),
				1,
			),
		).toBe(false);
		expect(usablePair(null, mapping(3), 1)).toBe(false);
	});

	it("does not hold for a null revision", () => {
		expect(usablePair(source("push", null), mapping(3), 1)).toBe(false);
		expect(usablePair(source("read", null), mapping(null), 1)).toBe(false);
	});

	it("does not hold for a push whose revision is not the mapping's", () => {
		expect(usablePair(source("push", 3), mapping(5), 1)).toBe(false);
		expect(usablePair(source("push", 3), null, 1)).toBe(false);
	});

	it("does not hold for a revision behind the app's greatest fold baseline", () => {
		expect(usablePair(source("push", 3), mapping(3), 4)).toBe(false);
		expect(usablePair(source("push", 4), mapping(4), 4)).toBe(true);
	});

	it("does not hold for a revision of 0, by the fold baseline alone", () => {
		expect(usablePair(source("push", 0), mapping(0), 1)).toBe(false);
	});

	it("does not hold where the app has no fold baseline", () => {
		expect(usablePair(source("push", 3), mapping(3), null)).toBe(false);
	});
});
