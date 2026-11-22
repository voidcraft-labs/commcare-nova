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

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { retainedBodyJson } from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { writeHqRoundTripHorizon } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import {
	childCreate,
	OP,
	OWN,
	own,
	placementFixture,
} from "@/lib/commcare/__tests__/placementFixture";
import { expandDoc } from "@/lib/commcare/expander";
import { placementCandidates } from "@/lib/commcare/placement";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { canonDocument } from "@/lib/commcare/reader/canon";
import {
	applyBlueprintChangeProposal,
	commitGuardedBatchProposal,
} from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	appendSyntheticBatch,
	loadApp,
	restoreApp,
	softDeleteApp,
} from "@/lib/db/apps";
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
import { renamedInNovaLine } from "@/lib/publish/hqChangesCopy";
import {
	scanDeploymentFold,
	writeDeploymentAwareFold,
} from "@/scripts/lib/deploymentFold";
import {
	type DeploymentFoldMigration,
	sameRepresentationFold,
} from "@/scripts/lib/deploymentFoldArtifacts";
import {
	appMappingToken,
	birthAdoptedApp,
	OWNERSHIP,
} from "../../__tests__/adoptedBirth";
import { certifyFold } from "../../__tests__/certifiedFold";
import { normalizeHqAppSource } from "../../hqSourceBaseline";
import { placementMoveOffer } from "../../placementMoves";
import { recordPublishPlacements } from "../../placements";
import {
	FIXTURE_REMOTE_APP_ID,
	seedFixtureConnection,
} from "../../reading/__tests__/adoptionFixture";
import { servedHqApp, serveHqApp } from "../../reading/__tests__/servedHqApp";
import { readBackDifferences } from "../../reading/readBack";
import {
	admitAppWrite,
	type DeploymentTargetKey,
	endDeployment,
	foldDeploymentAttempt,
	readAppBaseline,
	readDeployment,
	readFirstPublishStates,
	readTargetIdentity,
	recordRefreshedAppBaseline,
	recordRemoteResource,
	settleReleasedClaims,
	settleRemoteWrites,
} from "../../store";
import { EMPTY_TARGET_IDENTITY } from "../../targetIdentity";
import type { AppBaseline } from "../../types";
import { bringInHqChanges } from "../bringIn";
import { planFromDocuments } from "../plan";
import { loadReferenceDocument, usablePair } from "../reference";
import { reviewHqChanges } from "../review";
import { withReleasedFoldReader } from "./releasedFoldReader";

vi.mock("@/lib/commcare/encryption", () => ({
	decrypt: async () => "fixture-key",
}));

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

function storedRead(source: object, observedAt: string) {
	const text = JSON.stringify(source);
	return {
		sourceGzip: gzipSync(text),
		sourceDigest: createHash("sha256").update(text).digest("hex"),
		sourceBytes: Buffer.byteLength(text),
		observedAt,
	};
}

const move = (from: string, to: string) => ({ caseType: "patient", from, to });
const rename = (...renames: ReturnType<typeof move>[]): Mutation => ({
	kind: "renameCaseProperties",
	renames,
});
const remove = (property: string, caseType = "patient"): Mutation => ({
	kind: "removeCaseProperty",
	caseType,
	property,
});

async function publishedRenameCase(
	writer: boolean,
	saved: Record<string, string>,
	throughHq = false,
	extraTypes: NonNullable<BlueprintDoc["caseTypes"]> = [],
) {
	const target = { server: "india" as const, domain: "clinic" };
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	await h.seedProjectMember(COLLEAGUE, PROJECT, "editor");
	const db = h.db() as unknown as Kysely<Database>;
	const store = new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: OWNER,
		ownerId: OWNER,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
	const source = buildDoc({
		appName: "Published",
		caseTypes: [
			{
				name: "patient",
				properties: ["a", "c"].map((name) => ({
					name,
					label: name,
					data_type: "text",
				})),
			},
			...extraTypes,
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
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								...(writer && {
									caseWrite: { caseType: "patient", property: "a" },
								}),
							}),
						],
					},
				],
			},
		],
	});
	const appId = await h.seedAppWithBlueprint(source, {
		owner: OWNER,
		projectId: PROJECT,
	});
	const scope = {
		appId,
		projectId: PROJECT,
		actorUserId: OWNER,
		role: "owner",
	};
	const revision = await writeHqRoundTripHorizon(h.db(), appId, "Published");
	const remoteId = throughHq
		? FIXTURE_REMOTE_APP_ID
		: crypto.randomUUID().replaceAll("-", "");
	const deployed = { ...source, appId };
	let baseline: object = expandDoc(deployed);
	if (throughHq) {
		const normalized = normalizeHqAppSource(
			retainedBodyJson(servedHqApp(deployed, 1).source),
		);
		if ("malformed" in normalized)
			throw new Error("Expected the published app read.");
		baseline = JSON.parse(normalized.text);
		await seedFixtureConnection(OWNER);
	}
	const when = new Date().toISOString();
	await foldDeploymentAttempt(
		scope,
		target,
		"preflight",
		{ status: "succeeded", at: when },
		{ ensure: true, expectedEndings: 0 },
	);
	await recordRemoteResource(scope, target, {
		expectedEndings: 0,
		kind: "app",
		novaResourceId: appId,
		remoteId,
		ownership: "nova-created",
		pushedRevision: revision,
		remoteRevision: 1,
		uploadedAt: when,
		baseline: {
			origin: "push",
			remoteAppId: remoteId,
			...storedRead(baseline, when),
			ownership: OWNERSHIP,
			novaRevision: revision,
			discard: null,
			mediaFiles: { kind: "keep" },
			firstPublish: { kind: "keep" },
		},
	});
	await store.applySchemaChange({
		appId,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(source),
		syncedSeq: revision,
	});
	const caseId = crypto.randomUUID();
	await store.insert({
		appId,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: "Retained case",
			modified_on: new Date(),
			properties: saved,
		},
	});
	return { appId, revision, scope, target, caseId, db, store, deployed };
}
async function reviewRenameCase({
	appId,
	revision,
	scope,
	target,
}: Awaited<ReturnType<typeof publishedRenameCase>>) {
	const pair = await readAppBaseline(scope, target);
	if (!pair || pair.origin === "unread")
		throw new Error("The comparison is unavailable");
	const now = await head(appId);
	const ref = okOf(
		await loadReferenceDocument({
			appId,
			novaRevision: revision,
			head: now,
			binding: pair.foldBinding,
		}),
	);
	return {
		ref,
		plan: planFromDocuments({
			ref: ref.doc,
			now: now.doc,
			base: ref.doc,
			theirs: { ...ref.doc, appName: "Renamed in HQ" },
			renamesSince: ref.renamesSince,
		}),
	};
}

/** Exercise the review and apply entries with the same HQ edit and real
 * published reference. A refused request leaves the immutable binding and
 * head intact. A true round trip can take the remote name in one commit. */
async function takeRenameCase(
	published: Awaited<ReturnType<typeof publishedRenameCase>>,
	expected: ReturnType<typeof move>[],
) {
	const { scope, target, deployed, appId } = published;
	const peerApp = servedHqApp({ ...deployed, appName: "Renamed in HQ" }, 2);
	const before = await head(appId);
	const binding = await readAppBaseline(scope, target);
	await withHttpPeer(async (peer) => {
		serveHqApp(peer, peerApp, 2);
		const listed = await reviewHqChanges(scope, target, { onEvent: () => {} });
		if (listed.kind !== "changes")
			throw new Error(
				`Expected a published review; got ${JSON.stringify(listed)}`,
			);
		expect(listed.renamedInNova).toEqual(expected);
		const outcome = await bringInHqChanges(
			scope,
			target,
			{
				readingId: listed.readingId,
				reviewDigest: listed.reviewDigest,
				discardNovaChanges: listed.novaChanges.length > 0,
				tableChoices: {},
			},
			{ onEvent: () => {} },
		);
		if (expected.length) {
			expect(outcome).toMatchObject({
				kind: "refused",
				message: renamedInNovaLine(expected),
			});
			expect(await head(appId)).toEqual(before);
			expect(await readAppBaseline(scope, target)).toEqual(binding);
		} else {
			expect(outcome).toMatchObject({
				kind: "brought-in",
				seq: before.seq + 1,
			});
			expect((await head(appId)).doc.appName).toBe("Renamed in HQ");
			expect(await readAppBaseline(scope, target)).toMatchObject({
				origin: "changes",
				novaRevision: before.seq + 1,
			});
		}
	});
	await endDeployment(scope, target, FIXTURE_REMOTE_APP_ID);
}

interface RenameJourney {
	name: string;
	writer: boolean;
	rows: Mutation[];
	saved: Record<string, string>;
	after: Record<string, string>;
	renames: ReturnType<typeof move>[];
}

it.each<RenameJourney>([
	{
		name: "retired empty name then a round trip",
		writer: false,
		rows: [
			rename(move("a", "b")),
			rename(move("b", "a")),
			remove("a"),
			rename(move("c", "a")),
			rename(move("a", "c")),
		],
		saved: { c: "C" },
		after: { c: "C" },
		renames: [],
	},
	{
		name: "unrelated data moves through a reused name",
		writer: false,
		rows: [
			rename(move("a", "b")),
			remove("b"),
			rename(move("c", "b")),
			rename(move("b", "a")),
		],
		saved: { c: "C" },
		after: { a: "C" },
		renames: [move("c", "a")],
	},
	{
		name: "removing a writer’s annotation preserves its data",
		writer: true,
		rows: [rename(move("a", "b")), remove("b"), rename(move("b", "e"))],
		saved: { a: "A", c: "C" },
		after: { e: "A", c: "C" },
		renames: [move("a", "e")],
	},
	{
		name: "simultaneous moves preserve two independent saved values",
		writer: false,
		rows: [
			rename(move("a", "c"), move("c", "a")),
			rename(move("c", "b")),
			rename(move("a", "c")),
		],
		saved: { a: "A", c: "C" },
		after: { b: "A", c: "C" },
		renames: [move("a", "b")],
	},
])(
	"carries the same take decision at every fold boundary: $name",
	async (journey) => {
		for (let cut = -1; cut <= journey.rows.length; cut++) {
			const published = await publishedRenameCase(
				journey.writer,
				journey.saved,
			);
			const { appId, db, caseId } = published;
			await edit(appId, [{ kind: "setAppName", name: "Edited in Nova" }]);
			for (let index = 0; index <= journey.rows.length; index++) {
				if (index === cut) await certifyFold(h.db(), appId);
				if (cut >= 0 && index === Math.min(cut + 1, journey.rows.length))
					await certifyFold(h.db(), appId, "hq-round-trip-case-writes");
				const command = journey.rows[index];
				if (command)
					await applyBlueprintChangeProposal({
						appId,
						userId: index % 2 ? OWNER : COLLEAGUE,
						expectedProjectId: PROJECT,
						batchId: crypto.randomUUID(),
						kind: "autosave",
						guard: { mutations: [command] },
					});
			}
			const { ref, plan } = await reviewRenameCase(published);
			expect(ref.actors).toEqual([OWNER, COLLEAGUE]);
			expect(ref.renamesSince).toEqual(journey.renames);
			expect(plan).toMatchObject({
				kind: "changes",
				appliedTo: "published",
				renamedInNova: journey.renames,
			});
			expect(
				(
					await db
						.selectFrom("cases")
						.select("properties")
						.where("case_id", "=", caseId)
						.executeTakeFirstOrThrow()
				).properties,
			).toEqual(journey.after);
		}
	},
	30000,
);

async function mixedReleasedHolds(migration: DeploymentFoldMigration) {
	const household = (from: string, to: string) => ({
		caseType: "household",
		from,
		to,
	});
	const published = await publishedRenameCase(
		false,
		{ c: "Independent C" },
		true,
		[
			{
				name: "household",
				properties: ["a", "ghost"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text",
				})),
			},
		],
	);
	const { appId, db, store } = published;
	async function change(mutations: Mutation[]) {
		await applyBlueprintChangeProposal({
			appId,
			userId: OWNER,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			kind: "autosave",
			guard: { mutations },
		});
	}
	async function insertResponse(caseType: string, value: string) {
		const now = await head(appId);
		await store.applySchemaChange({
			appId,
			caseType,
			caseTypeSchemas: buildCaseTypeMap(now.doc),
			syncedSeq: now.seq,
		});
		const id = crypto.randomUUID();
		await store.insert({
			appId,
			row: {
				case_id: id,
				case_name: caseType,
				case_type: caseType,
				modified_on: new Date(),
				properties: { b: value },
			},
		});
		return id;
	}
	await change([
		rename(move("a", "b"), household("a", "b"), household("ghost", "gone")),
	]);
	await change([
		remove("b"),
		remove("b", "household"),
		remove("gone", "household"),
	]);
	await change(
		["patient", "household"].map((caseType) => ({
			kind: "addCaseProperty",
			caseType,
			after: null,
			property: {
				name: "b",
				label: proseText("Later answer"),
				data_type: "text",
			},
		})),
	);
	const patientCase = await insertResponse("patient", "Later patient answer");
	const householdCase = await insertResponse(
		"household",
		"Later household answer",
	);
	await change([rename(move("b", "a"), household("b", "z"))]);
	await change([{ kind: "setAppName", name: "Edited in Nova" }]);
	const displayed = [household("a", "z"), household("ghost", "gone")];
	const active = [move("b", "a"), household("b", "z")];
	const all = [...displayed, ...active];
	for (const cutover of [
		"hq-round-trip-expressions",
		"hq-round-trip-case-writes",
	] as const) {
		await certifyFold(
			h.db(),
			appId,
			cutover,
			cutover === "hq-round-trip-expressions"
				? migration
				: sameRepresentationFold,
		);
		const held = await h
			.db()
			.selectFrom("app_deployment_fold_references")
			.select("state")
			.where("app_id", "=", appId)
			.orderBy("fold_seq", "desc")
			.executeTakeFirstOrThrow();
		expect(held.state).toMatchObject({
			kind: "ok",
			renamesSince: displayed,
			activeRenames: active,
		});
		const { plan } = await reviewRenameCase(published);
		expect(plan).toMatchObject({
			kind: "changes",
			appliedTo: "published",
			batch: [],
			renamedInNova: all,
		});
	}
	await takeRenameCase(published, all);
	for (const [id, expected] of [
		[patientCase, { a: "Later patient answer" }],
		[householdCase, { z: "Later household answer" }],
	] as const) {
		expect(
			(
				await db
					.selectFrom("cases")
					.select("properties")
					.where("app_id", "=", appId)
					.where("case_id", "=", id)
					.executeTakeFirstOrThrow()
			).properties,
		).toEqual(expected);
	}
}

it("carries live saved values across the released decoder even when its displayed rename survives a removal", async () => {
	await withReleasedFoldReader(async (migration) => {
		const outward = [move("a", "b"), move("c", "d")],
			back = [move("b", "a"), move("d", "c")];
		// The release cuts straddle the removal and reuse of b. A writer in
		// the control keeps that very same storage slot alive at both cuts.
		for (const writer of [false, true])
			for (const cut of [1, 2, 3, 4, 5]) {
				const before: Record<string, string> = writer
					? { a: "Original A", c: "Independent C" }
					: { c: "Independent C" };
				const throughHq = cut >= 4;
				const published = await publishedRenameCase(writer, before, throughHq);
				const { appId, revision, store, db, caseId } = published;
				const nextCase = crypto.randomUUID();
				const mutations: Mutation[] = [
					rename(...outward),
					remove("b"),
					{
						kind: "addCaseProperty",
						caseType: "patient",
						after: null,
						property: {
							name: "b",
							label: proseText("Worker response"),
							data_type: "text",
						},
					},
					rename(...back),
					{ kind: "setAppName", name: "Edited in Nova" },
				];
				for (let index = 0; index <= mutations.length; index++) {
					if (index === cut) {
						// The selected source release kept both a→b and c→d on its review,
						// even after the empty b was retired. The operator preserves that
						// exact decision through an immediate second fold with no suffix.
						for (const cutover of [
							"hq-round-trip-expressions",
							"hq-round-trip-case-writes",
						] as const) {
							await certifyFold(
								h.db(),
								appId,
								cutover,
								cutover === "hq-round-trip-expressions"
									? migration
									: sameRepresentationFold,
							);
							const state = await h
								.db()
								.selectFrom("app_deployment_fold_references")
								.select("state")
								.where("app_id", "=", appId)
								.orderBy("fold_seq", "desc")
								.executeTakeFirstOrThrow();
							const displayed = cut < 4 ? outward : [];
							const active =
								cut < 4
									? writer || cut === 1
										? outward
										: [move("c", "d")]
									: writer
										? []
										: [move("b", "a")];
							expect(state.state).toMatchObject({
								kind: "ok",
								renamesSince: displayed,
								activeRenames: active,
							});
							const { ref } = await reviewRenameCase(published);
							expect(ref.renamesSince).toEqual(cut < 4 ? outward : active);
						}
					}
					const command = mutations[index];
					if (!command) break;
					await applyBlueprintChangeProposal({
						appId,
						userId: index % 2 ? OWNER : COLLEAGUE,
						expectedProjectId: PROJECT,
						batchId: crypto.randomUUID(),
						kind: "autosave",
						guard: { mutations: [command] },
					});
					if (index === 2) {
						const current = await head(appId);
						await store.applySchemaChange({
							appId,
							caseType: "patient",
							caseTypeSchemas: buildCaseTypeMap(current.doc),
							syncedSeq: current.seq,
						});
						await store.insert({
							appId,
							row: {
								case_id: nextCase,
								case_type: "patient",
								case_name: "Later case",
								modified_on: new Date(),
								properties: { b: "Later B" },
							},
						});
					}
				}
				const { ref, plan } = await reviewRenameCase(published);
				expect(ref.actors).toEqual([COLLEAGUE, OWNER]);
				const moves = writer ? [] : [move("b", "a")];
				expect(ref.renamesSince).toEqual(moves);
				expect(
					plan,
					plan.kind === "changes"
						? undefined
						: JSON.stringify({ writer, cut, plan }),
				).toMatchObject({
					kind: "changes",
					appliedTo: "published",
					renamedInNova: moves,
				});
				if (plan.kind !== "changes") throw new Error("Expected a review.");
				if (writer) expect(plan.batch.length).toBeGreaterThan(0);
				else expect(plan.batch).toEqual([]);
				expect(
					(await readAppBaseline(published.scope, published.target))
						?.novaRevision,
				).toBe(revision);
				if (throughHq) await takeRenameCase(published, moves);
				for (const [id, saved] of [
					[caseId, before],
					[nextCase, { a: "Later B" }],
				] as const) {
					expect(
						(
							await db
								.selectFrom("cases")
								.select("properties")
								.where("app_id", "=", appId)
								.where("case_id", "=", id)
								.executeTakeFirstOrThrow()
						).properties,
					).toEqual(saved);
				}
			}
		await mixedReleasedHolds(migration);
	});
}, 240_000);

describe("published comparisons at a new fold", () => {
	it("keeps two targets’ original revisions, composes the next edits and rebinds only the fresh reads", async () => {
		const { appId, revision } = await published();
		const scope = {
			appId,
			projectId: PROJECT,
			actorUserId: OWNER,
			role: "owner",
		};
		const north = { server: "india", domain: "north" } as const;
		const south = { server: "india", domain: "south" } as const;
		const shell = { server: "india", domain: "setup" } as const;
		const original = "2026-11-21T00:00:00Z";
		const refreshTime = "2026-11-21T00:01:00Z";

		async function publish(
			target: DeploymentTargetKey,
			remoteId: string,
			doc: BlueprintDoc,
			seq: number,
			options?: {
				list?: "first-publish" | "next-publish";
				unread?: boolean;
				at?: string;
			},
		) {
			const at = options?.at ?? original;
			await foldDeploymentAttempt(
				scope,
				target,
				"preflight",
				{ status: "succeeded", at },
				{ ensure: true, expectedEndings: 0 },
			);
			await recordRemoteResource(scope, target, {
				expectedEndings: 0,
				kind: "app",
				novaResourceId: appId,
				remoteId,
				ownership: "nova-created",
				pushedRevision: seq,
				remoteRevision: options?.at ? 2 : 1,
				uploadedAt: at,
				baseline: {
					origin: options?.unread ? "unread" : "push",
					remoteAppId: remoteId,
					...storedRead(expandDoc(doc), at),
					...(options?.unread && {
						sourceGzip: null,
						sourceBytes: null,
						sourceDigest: null,
					}),
					ownership: options?.unread ? null : OWNERSHIP,
					discard: null,
					novaRevision: options?.unread ? null : seq,
					mediaFiles: { kind: "set", files: {} },
					firstPublish: {
						kind: "set",
						list: options?.list
							? {
									ids: ["forms-and-settings-rewritten"],
									webAppsOnInHq: false,
									of: options.list,
								}
							: null,
					},
				},
			});
		}
		async function baseline(target: DeploymentTargetKey) {
			const row = await readAppBaseline(scope, target);
			if (!row || row.origin === "unread" || row.novaRevision === null)
				throw new Error("Expected a published revision.");
			return { ...row, novaRevision: row.novaRevision };
		}
		async function referenceOn(target: DeploymentTargetKey) {
			const row = await baseline(target);
			return okOf(
				await loadReferenceDocument({
					appId,
					novaRevision: row.novaRevision,
					head: await head(appId),
					binding: row.foldBinding,
				}),
			);
		}
		async function fold(
			cutover: "hq-round-trip-expressions" | "hq-round-trip-case-writes",
		) {
			const written = await certifyFold(h.db(), appId, cutover);
			expect(written).toMatchObject({ usable: 2, unavailable: 1 });
		}
		const northId = "a".repeat(32),
			southId = "b".repeat(32);
		const rename = (from: string, to: string) => ({
			kind: "renameCaseProperties" as const,
			renames: [{ caseType: "patient", from, to }],
		});
		await publish(north, northId, await headDoc(appId), revision, {
			list: "first-publish",
		});
		await edit(appId, [rename("note", "remark")]);
		await edit(appId, [{ kind: "setAppName", name: "South clinic" }]);
		const southHead = await head(appId);
		await publish(south, southId, southHead.doc, southHead.seq, {
			list: "next-publish",
		});
		await publish(shell, "c".repeat(32), southHead.doc, southHead.seq, {
			unread: true,
		});
		await edit(
			appId,
			[
				{ kind: "setAppName", name: "My unpublished name" },
				{ kind: "updatePersona", uuid: PERSONA, patch: { name: "My worker" } },
			],
			COLLEAGUE,
		);
		const before = [await referenceOn(north), await referenceOn(south)];
		const beforeLists = await readFirstPublishStates(scope);
		await fold("hq-round-trip-expressions");
		const after = [await referenceOn(north), await referenceOn(south)];
		expect(after.map((ref) => toPersistableDoc(ref.doc))).toEqual(
			before.map((ref) => toPersistableDoc(ref.doc)),
		);
		expect(after.map((ref) => toPersistableDoc(ref.identityDoc))).toEqual(
			before.map((ref) => toPersistableDoc(ref.identityDoc)),
		);
		expect(after.map((ref) => ref.doc.appName)).toEqual([
			"Clinic",
			"South clinic",
		]);
		expect(after.map((ref) => ref.actors)).toEqual([
			[OWNER, COLLEAGUE],
			[COLLEAGUE],
		]);
		expect(await readFirstPublishStates(scope)).toEqual(beforeLists);
		expect(await readAppBaseline(scope, shell)).toMatchObject({
			origin: "unread",
			novaRevision: null,
		});
		const previousNorth = await baseline(north),
			previousSouth = await baseline(south);
		await expect(
			readAppBaseline({ ...scope, actorUserId: "former-member" }, north),
		).rejects.toThrow();
		if (!previousNorth.foldBinding)
			throw new Error(
				"Expected the northern deployment’s certified comparison.",
			);
		await expect(
			loadReferenceDocument({
				appId,
				novaRevision: revision,
				head: await head(appId),
				binding: { ...previousNorth.foldBinding, projectId: OTHER_PROJECT },
			}),
		).rejects.toThrow("comparison changed");
		await expect(
			loadReferenceDocument({
				appId,
				novaRevision: revision,
				head: await head(appId),
				binding: { ...previousNorth.foldBinding, sourceDigest: "0".repeat(64) },
			}),
		).rejects.toThrow("comparison changed");
		const identity = {
			...EMPTY_TARGET_IDENTITY,
			entities: [
				{
					entityKind: "form" as const,
					novaEntityUuid: FORM,
					uniqueId: "f".repeat(32),
					xmlns: null,
				},
			],
		};
		const northRead = {
			expectedEndings: 0,
			remoteAppId: northId,
			comparedPushToken: previousNorth.foldBinding.mappingToken,
			comparedDigest: previousNorth.sourceDigest,
			comparedRevision: previousNorth.novaRevision,
			comparedFold: previousNorth.foldBinding?.foldSeq,
			read: storedRead(
				{ ...(previousNorth.source as object), fuzzy_search: true },
				refreshTime,
			),
		};
		const southRead = {
			expectedEndings: 0,
			remoteAppId: southId,
			comparedPushToken: appMappingToken(await readDeployment(scope, south)),
			comparedDigest: previousSouth.sourceDigest,
			comparedRevision: previousSouth.novaRevision,
			comparedFold: previousSouth.foldBinding?.foldSeq,
			read: storedRead(
				{ ...(previousSouth.source as object), modified_on: refreshTime },
				refreshTime,
			),
			targetIdentity: { read: EMPTY_TARGET_IDENTITY, next: identity },
			mediaFiles: {
				read: previousSouth.mediaFiles,
				next: { "commcare/image/visit.png": "learned" },
			},
		};
		expect(
			(await recordRefreshedAppBaseline(scope, north, northRead)).outcome,
		).toBe("current");
		expect(
			(await recordRefreshedAppBaseline(scope, south, southRead)).outcome,
		).toBe("current");
		expect(
			(await recordRefreshedAppBaseline(scope, south, southRead)).outcome,
		).toBe("current");
		for (const [target, read] of [
			[north, northRead],
			[south, southRead],
		] as const) {
			expect(
				(
					await recordRefreshedAppBaseline(scope, target, {
						...read,
						read: storedRead({ changed: "earlier" }, "2026-11-21T00:00:30Z"),
						targetIdentity: {
							read: await readTargetIdentity(scope, target),
							next: EMPTY_TARGET_IDENTITY,
						},
					})
				).outcome,
			).toBe("superseded");
			expect((await baseline(target)).foldBinding?.sourceDigest).toBe(
				read.read.sourceDigest,
			);
		}
		expect(await readTargetIdentity(scope, south)).toEqual(identity);
		expect((await baseline(south)).mediaFiles).toEqual(
			southRead.mediaFiles.next,
		);
		expect(await readFirstPublishStates(scope)).toEqual(beforeLists);
		await edit(appId, [rename("remark", "summary")]);
		for (const [target, expected] of [
			[north, "note"],
			[south, "remark"],
		] as const) {
			const ref = await referenceOn(target);
			expect(ref.renamesSince).toEqual([
				{ caseType: "patient", from: expected, to: "summary" },
			]);
			const plan = planFromDocuments({
				ref: ref.doc,
				now: await headDoc(appId),
				base: ref.doc,
				theirs: { ...ref.doc, appName: "HQ editor renamed this" },
				renamesSince: ref.renamesSince,
			});
			expect(plan).toMatchObject({
				kind: "changes",
				appliedTo: "published",
				target: { appName: "HQ editor renamed this" },
			});
		}
		await fold("hq-round-trip-case-writes");
		expect((await referenceOn(north)).renamesSince).toEqual([
			{ caseType: "patient", from: "note", to: "summary" },
		]);
		expect((await baseline(north)).novaRevision).toBe(revision);
		expect((await baseline(south)).novaRevision).toBe(southHead.seq);
		const now = await head(appId);
		await publish(north, northId, now.doc, now.seq, {
			at: "2026-11-21T00:10:00Z",
		});
		expect((await baseline(north)).foldBinding).toBeUndefined();
		expect((await referenceOn(north)).doc.appName).toBe("My unpublished name");
		await endDeployment(scope, south, southId);
		expect((await baseline(south)).foldBinding).toBeUndefined();
	});
});

it("keeps a released comparison through restore and a fold, and fences reads from the earlier claim after reclaim", async () => {
	const appId = testUuid("restored-fold-app");
	const target = { server: "india", domain: "restore" } as const;
	const remoteAppId = "a".repeat(32);
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const setup = { projectId: PROJECT, actorUserId: OWNER, target, remoteAppId };
	const { scope } = await birthAdoptedApp(h, { ...setup, appId });
	await certifyFold(h.db(), appId);
	const before = await readAppBaseline(scope, target);
	if (!before || before.origin === "unread" || !before.foldBinding)
		throw new Error("Expected the original comparison.");
	const binding = before.foldBinding;
	const read = {
		expectedEndings: 0,
		comparedPushToken: binding.mappingToken,
		remoteAppId,
		comparedDigest: before.sourceDigest,
		comparedFold: binding.foldSeq,
		comparedRevision: binding.novaRevision,
		read: storedRead({ name: "Read while away" }, new Date().toISOString()),
		mediaFiles: {
			read: before.mediaFiles,
			next: { "commcare/image/logo.png": "from-a-stale-read" },
		},
		targetIdentity: {
			read: await readTargetIdentity(scope, target),
			next: EMPTY_TARGET_IDENTITY,
		},
	};
	const beforeReference = await loadReferenceDocument({
		appId,
		novaRevision: binding.novaRevision,
		binding,
		head: await head(appId),
	});
	const oldHead = await head(appId);
	const input = {
		appId,
		projectId: PROJECT,
		headSeq: oldHead.seq,

		migration: sameRepresentationFold,
	};
	const scan = () =>
		h
			.db()
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => scanDeploymentFold(tx, input));
	const originalReceipt = await scan();
	await softDeleteApp(appId, OWNER);
	const otherAppId = testUuid("second-restored-fold-app");
	const other = await birthAdoptedApp(h, { ...setup, appId: otherAppId });
	const admitted = await admitAppWrite(other.scope, target, {
		compiledIdentity: other.targetIdentity,
		observedPushToken: appMappingToken(other.deployment),
		expectedEndings: 0,
		remoteAppId,
		writeKind: "media",
	});
	if (admitted.kind !== "admitted")
		throw new Error("Expected the other app's active HQ write.");
	await softDeleteApp(otherAppId, OWNER);
	await restoreApp(appId, OWNER);
	const releasedReceipt = await scan();
	expect(releasedReceipt).toMatchObject({ usable: 0, unavailable: 1 });
	expect(releasedReceipt.digest).not.toBe(originalReceipt.digest);
	await expect(
		h.withTransaction((tx) =>
			writeDeploymentAwareFold(tx, input, originalReceipt, async () => {
				throw new Error("A stale receipt reached the horizon writer.");
			}),
		),
	).rejects.toThrow("deployment comparisons changed after the fold scan");
	expect(await scan()).toEqual(releasedReceipt);
	expect(await settleReleasedClaims(scope)).toMatchObject({
		waiting: [target],
	});
	expect(await readAppBaseline(scope, target)).not.toHaveProperty(
		"foldBinding",
	);
	await expect(
		loadReferenceDocument({
			appId,
			head: oldHead,
			novaRevision: binding.novaRevision,
			binding,
		}),
	).rejects.toThrow("comparison changed");
	expect((await recordRefreshedAppBaseline(scope, target, read)).outcome).toBe(
		"superseded",
	);
	expect(await readTargetIdentity(scope, target)).toEqual(
		read.targetIdentity.read,
	);
	expect((await readAppBaseline(scope, target))?.mediaFiles).toEqual(
		before.mediaFiles,
	);

	// Reclaim without any fresh publish, fold or source read. The old
	// comparison is available again, but the remote request that crossed the
	// release still cannot land or reuse its old certified read handle.
	await settleRemoteWrites([admitted.writeId], { kind: "settled" });
	expect(await settleReleasedClaims(scope)).toMatchObject({ waiting: [] });
	const reclaimed = await readAppBaseline(scope, target);
	if (!reclaimed || reclaimed.origin === "unread" || !reclaimed.foldBinding)
		throw new Error("Expected the reclaimed comparison.");
	expect(reclaimed.foldBinding.mappingToken).not.toBe(binding.mappingToken);
	expect(
		await admitAppWrite(scope, target, {
			compiledIdentity: await readTargetIdentity(scope, target),
			observedPushToken: binding.mappingToken,
			expectedEndings: 0,
			remoteAppId,
			writeKind: "import",
			compiledAtSeq: 1,
		}),
	).toEqual({ kind: "mapping-moved" });
	expect((await recordRefreshedAppBaseline(scope, target, read)).outcome).toBe(
		"superseded",
	);
	await expect(
		loadReferenceDocument({
			appId,
			head: oldHead,
			novaRevision: binding.novaRevision,
			binding,
		}),
	).rejects.toThrow("comparison changed");
	expect(
		await loadReferenceDocument({
			appId,
			head: oldHead,
			novaRevision: binding.novaRevision,
			binding: reclaimed.foldBinding,
		}),
	).toEqual(beforeReference);

	// The next actual release spans a conversion of the recoverable app.
	// Its holder is in recently deleted but the other app can reclaim on restore.
	await softDeleteApp(appId, OWNER);
	await restoreApp(otherAppId, OWNER);
	expect(
		await certifyFold(h.db(), appId, "hq-round-trip-case-writes"),
	).toMatchObject({ usable: 0, unavailable: 1 });
	await softDeleteApp(otherAppId, OWNER);
	await restoreApp(appId, OWNER);
	const after = await readAppBaseline(scope, target);
	if (!after || after.origin === "unread" || !after.foldBinding)
		throw new Error("Expected the restored comparison at the new fold.");
	expect(after).toMatchObject({
		novaRevision: binding.novaRevision,
		sourceDigest: before.sourceDigest,
		mediaFiles: before.mediaFiles,
	});
	expect(
		await loadReferenceDocument({
			appId,
			head: await head(appId),
			novaRevision: binding.novaRevision,
			binding: after.foldBinding,
		}),
	).toEqual(beforeReference);
	expect(
		(
			await recordRefreshedAppBaseline(scope, target, {
				...read,
				comparedPushToken: after.foldBinding.mappingToken,
				comparedFold: after.foldBinding.foldSeq,
			})
		).outcome,
	).toBe("current");
	expect(await readTargetIdentity(scope, target)).toEqual(
		EMPTY_TARGET_IDENTITY,
	);
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
	const mapping = (pushedRevision: number | null) => ({
		releasedAt: null,
		pushedRevision,
		remoteId: "hq-app",
		deploymentId: "deployment",
	});

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
