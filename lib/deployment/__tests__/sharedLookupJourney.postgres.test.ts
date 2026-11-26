import AdmZip from "adm-zip";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { applyBlueprintChangeProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	getLookupFixtureData,
	getLookupTable,
	updateLookupTableTag,
} from "@/lib/lookup/service";
import {
	hqAuthoredDocument,
	loadRetainedHqApp,
	type RetainedHqAnswer,
} from "@/proof/corpus/hqAuthored";
import { importFile, PROOF_DOMAIN } from "@/proof/corpus/publish";
import { type PeerTable, withTargetPeer } from "@/proof/corpus/targetPeer";
import { edit } from "@/proof/matrix/hand/hq-shared-table-journey/edit";
import { createInputFor, reviewOf } from "../reading/__tests__/adoptionFixture";
import { createFromReview } from "../reading/create";
import { authorizeBringIn, readHqAppForReview } from "../reading/read";
import type { ReadingKey } from "../reading/types";
import { readTargetIdentity } from "../store";
import { reloadHeadFor } from "./publishFixtures";
import { publishFromSession } from "./publishWithGrant";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => vi.mocked(decrypt).mockResolvedValue("journey-key"));

const h = setupAppStateTestDb("shared_lookup_journey_", {
	authSchema: "migrated",
});
const actorId = "journey-editor";
const projectId = "shared-clinic-project";
const credentials = {
	username: "journey-editor",
	apiKey: "journey-key",
	server: "production" as const,
};
const origin = { server: credentials.server, domain: PROOF_DOMAIN };
const overseas = { server: credentials.server, domain: "second-clinic" };
const projectScope = { projectId, actorId, role: "owner" };
const options = { onEvent: () => {} };
const base = "hq-shared-table-journey";

function body(answer: RetainedHqAnswer): Record<string, unknown> {
	return JSON.parse(answer.body ?? "") as Record<string, unknown>;
}

function serveReading(
	peer: MockAgent,
	key: ReadingKey,
	first: ReturnType<typeof loadRetainedHqApp>,
	changed: boolean,
) {
	const root = `/a/${key.domain}`;
	const host = peer.get(COMMCARE_SERVERS[key.server].baseUrl);
	const serve = (
		path: string,
		answer: RetainedHqAnswer,
		edited?: Record<string, unknown>,
	) => {
		host
			.intercept({ method: "GET", path })
			.reply(
				answer.status,
				edited === undefined ? (answer.body ?? "") : JSON.stringify(edited),
				{ headers: { ...answer.headers } },
			)
			.persist();
	};
	const source = body(first.source);
	const application = body(first.application);
	const counter = body(first.currentVersion);
	const revision = Number(application.version) + 1;
	if (changed) {
		source.name = application.name = "Clinic and outreach visits";
		source.version = application.version = counter.currentVersion = revision;
	}
	serve(`${root}/apps/source/${key.remoteAppId}/`, first.source, source);
	serve(
		`${root}/api/application/v1/${key.remoteAppId}/`,
		first.application,
		application,
	);
	serve(
		`${root}/apps/view/${key.remoteAppId}/current_version/`,
		first.currentVersion,
		counter,
	);
	serve(`${root}/api/lookup_table/v1/?limit=1000`, first.lookupTables);
	const [table] = body(first.lookupTables).objects as {
		id: string;
		tag: string;
	}[];
	const rows = first.fixtureRows?.[table.tag];
	if (!rows) throw new Error("The retained HQ table has no rows response.");
	serve(`${root}/api/fixture/v1/?fixture_type_id=${table.id}`, rows);
	return source;
}

function appScope(appId: string) {
	return { appId, projectId, actorUserId: actorId, role: projectScope.role };
}

async function publish(
	appId: string,
	target: typeof origin,
	onUploadStarted?: () => void,
) {
	const reloadHead = reloadHeadFor(appId, actorId);
	const { doc, seq } = await reloadHead();
	return publishFromSession({
		...target,
		scope: appScope(appId),
		doc,
		compiledAtSeq: seq,
		reloadHead,
		appName: doc.appName,
		requireHqImport: null,
		confirm: (["lookup-tables", "web-apps"] as const).map((subject) => ({
			kind: "plan-feature",
			subject,
		})),
		onUploadStarted,
	});
}

function targetPeer(domain: string, appId: string) {
	return {
		credentials,
		domain,
		appId,
		flags: new Set<string>(),
		caseSearchEnabled: false,
		cloudcareGranted: true,
		commcareVersion: "2.57.0",
	};
}

function identities(source: Readonly<Record<string, unknown>>) {
	const [menu] = source.modules as {
		unique_id: string;
		forms: { unique_id: string; xmlns: string }[];
	}[];
	return {
		menu: menu.unique_id,
		form: menu.forms[0].unique_id,
		xmlns: menu.forms[0].xmlns,
	};
}

function fixtureTable(
	retained: ReturnType<typeof loadRetainedHqApp>,
): PeerTable {
	const [table] = body(retained.lookupTables).objects as {
		id: string;
		tag: string;
	}[];
	const answer = retained.fixtureRows?.[table.tag];
	if (!answer) throw new Error("The retained HQ table has no rows.");
	const rows = body(answer).objects as {
		id: string;
		fields: Record<string, string>;
	}[];
	return {
		...table,
		isGlobal: true,
		fields: ["code", "name"].map((name) => ({ name, properties: [] })),
		itemAttributes: [],
		description: "",
		rows: rows.map(({ id, fields }) => ({
			id,
			itemAttributes: {},
			fields: Object.fromEntries(
				Object.entries(fields).map(([name, value]) => [
					name,
					[{ value, properties: {} }],
				]),
			),
		})),
	};
}

it("keeps the source app and its shared lookup through renewed consent, publish, and manual delivery", async () => {
	const retained = loadRetainedHqApp(base);
	const remoteAppId = String(body(retained.application).id);
	const key = { ...origin, projectId, remoteAppId };
	await h.seedProjectMember(actorId, projectId, "owner");
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: actorId,
			commcare_username: credentials.username,
			commcare_api_key: "ciphertext",
			commcare_server: origin.server,
			approved_domains: JSON.stringify(
				[origin, overseas].map(({ domain }) => ({
					name: domain,
					displayName: domain,
				})),
			),
			updated_at: new Date(),
		})
		.execute();
	const actor = await authorizeBringIn(actorId, projectId);
	if (!actor)
		throw new Error(
			"The fixture Project owner needs to be able to bring in the app.",
		);
	const reviewed = await withHttpPeer(async (peer) => {
		serveReading(peer, key, retained, false);
		return reviewOf(await readHqAppForReview(actor, key, options));
	});
	const { created, reviewedSource } = await withHttpPeer(async (peer) => {
		const reviewedSource = serveReading(peer, key, retained, true);
		const stale = await createFromReview(
			actor,
			createInputFor(key, reviewed),
			options,
		);
		if (stale.kind !== "changed" || stale.now.kind !== "review")
			throw new Error(JSON.stringify(stale));
		expect(stale.now.reviewDigest).not.toBe(reviewed.reviewDigest);
		expect(
			await h
				.db()
				.selectFrom("lookup_tables")
				.select("id")
				.where("project_id", "=", projectId)
				.execute(),
		).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("apps")
				.select("id")
				.where("project_id", "=", projectId)
				.execute(),
		).toEqual([]);
		return {
			created: await createFromReview(
				actor,
				createInputFor(key, stale.now),
				options,
			),
			reviewedSource,
		};
	});
	if (created.kind !== "created") throw new Error(JSON.stringify(created));
	const appId = created.receipt.appId;
	const head = reloadHeadFor(appId, actorId);
	const firstDoc = (await head()).doc;
	const [tableId] = extractLookupReferenceTargets(firstDoc).tableIds;
	if (!tableId)
		throw new Error("The adopted app needs to read the shared table.");
	const site = Object.values(firstDoc.fields).find(
		(field) => field.id === "site",
	);
	if (site?.kind !== "single_select" || site.optionsSource.kind !== "lookup")
		throw new Error("The adopted visit needs its lookup question.");
	const initial = await getLookupTable(projectScope, tableId);
	const code = initial.columns.find((column) => column.wireName === "code");
	const label = initial.columns.find((column) => column.wireName === "name");
	if (!code || !label)
		throw new Error("The shared table needs its code and name.");
	expect(
		initial.rows.map((row) => [row.values[code.id], row.values[label.id]]),
	).toEqual([
		["north", "Hill clinic"],
		["south", "River clinic"],
	]);
	expect(initial.hq).toMatchObject({
		managedBy: "commcare-hq",
		...origin,
		remoteId: fixtureTable(retained).id,
	});
	const sibling = await h.seedAppWithBlueprint(
		buildDoc({
			appName: "Outreach visits",
			modules: [
				{
					name: "Outreach",
					forms: [
						{
							uuid: testUuid("outreach-form"),
							name: "Outreach",
							type: "survey",
							fields: [
								{
									kind: "single_select",
									id: "site",
									optionsSource: site.optionsSource,
								},
							],
						},
					],
				},
			],
		}),
		{ owner: actorId, projectId },
	);
	const siblingHead = reloadHeadFor(sibling, actorId);
	const siblingBefore = await siblingHead();
	expect(extractLookupReferenceTargets(siblingBefore.doc).tableIds).toEqual([
		tableId,
	]);
	const nativeTable = fixtureTable(retained);

	const adoptedBefore = await readTargetIdentity(appScope(appId), origin);
	expect(adoptedBefore.entities).toHaveLength(2);
	await applyBlueprintChangeProposal({
		appId,
		userId: actorId,
		expectedProjectId: projectId,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: { mutations: edit(firstDoc) },
	});
	const siblingRemoteId = "published-outreach";
	const siblingIdentities = await withTargetPeer(
		targetPeer(origin.domain, siblingRemoteId),
		async (peer) => {
			peer.holdTables([nativeTable]);
			const result = await publish(sibling, origin);
			if (!result.landed) throw new Error(JSON.stringify(result.refusal));
			expect(result.sent.map((resource) => resource.kind)).toEqual([
				"app",
				"app",
			]);
			const held = peer.snapshot();
			expect(held.tables).toEqual([nativeTable]);
			if (!held.source)
				throw new Error("HQ needs the sibling's published app.");
			expect(peer.unexpected).toEqual([]);
			return identities(held.source);
		},
	);
	await withTargetPeer(targetPeer(origin.domain, remoteAppId), async (peer) => {
		peer.holdTables([nativeTable]);
		peer.holdSource(reviewedSource);
		const result = await publish(appId, origin);
		if (!result.landed) throw new Error(JSON.stringify(result.refusal));
		expect(result.hqAppAction).toBe("updated");
		expect(result.sent.map((resource) => resource.kind)).toEqual(["app"]);
		const held = peer.snapshot();
		expect(held.tables).toEqual([nativeTable]);
		expect(held.source?.langs).toEqual(["fra", "en"]);
		if (!held.source) throw new Error("HQ needs the edited source.");
		expect(identities(held.source)).toEqual(identities(reviewedSource));
		expect(identities(held.source)).not.toEqual(siblingIdentities);
		expect(peer.unexpected).toEqual([]);
	});
	expect(await readTargetIdentity(appScope(appId), origin)).toEqual(
		adoptedBefore,
	);
	expect(await siblingHead()).toEqual(siblingBefore);

	const catalog = await getLookupFixtureData(projectScope, [tableId], "export");
	const edited = await head();
	const authored = await hqAuthoredDocument(retained);
	const file = new AdmZip(
		await importFile(
			{
				...authored,
				doc: toPersistableDoc(edited.doc),
				lookup: catalog,
				compiledAtSeq: edited.seq,
			},
			origin.domain,
		),
	);
	const appFile = file
		.getEntries()
		.find((entry) => entry.entryName.endsWith(".json"));
	expect(
		JSON.parse(appFile?.getData().toString("utf-8") ?? "null")?.langs,
	).toEqual(["fra", "en"]);
	expect(file.readAsText("README.txt")).toContain(
		"uses the existing table in nova-proof",
	);
	expect(file.readAsText("README.txt")).toContain("selected-table export");
	expect(
		file.getEntries().some(({ entryName }) => entryName.endsWith(".xlsx")),
	).toBe(false);

	await withTargetPeer(
		targetPeer(overseas.domain, "unbound-destination"),
		async (peer) => {
			const upload = vi.fn();
			const refused = await publish(appId, overseas, upload);
			expect(refused).toMatchObject({
				landed: false,
				refusal: { phase: "preflight" },
			});
			if (refused.landed)
				throw new Error("An incomplete destination accepted a direct publish.");
			expect(refused.refusal.failure.code).toBe("app_not_ready");
			expect(JSON.stringify(refused.refusal.failure)).toContain("visit_sites");
			expect(upload).not.toHaveBeenCalled();
			expect(peer.requests.filter(({ method }) => method !== "GET")).toEqual(
				[],
			);
			expect(peer.snapshot()).toMatchObject({ source: undefined, tables: [] });
			expect(peer.unexpected).toEqual([]);
		},
	);
	await expect(
		updateLookupTableTag(projectScope, {
			tableId,
			expectedTableRevision: initial.tableRevision,
			tag: "another_name",
		}),
	).rejects.toMatchObject({ code: "managed_in_hq" });
	const final = await getLookupTable(projectScope, tableId);
	expect(final.hq).toEqual(initial.hq);
	expect(final.rows).toEqual(initial.rows);
}, 45_000);
