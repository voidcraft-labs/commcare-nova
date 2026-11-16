/**
 * The publish dialog's read of where a CCZ can be made for, against real
 * Postgres: the Project gate, the ledger's reached deployments, the lines
 * the stored document gives when no project space holds the app, and no
 * target at all for an app that does not declare Android.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { getSession } from "@/lib/auth-utils";
import { caseOperationFixture } from "@/lib/commcare/__tests__/caseOperationFixture";
import { nestedMenuWireFixture } from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { authoredCaseIdPrefix } from "@/lib/domain/caseOperationIdentity";
import { readDownloadTargetsAction } from "../actions";
import {
	downloadKeptAdvisoryFacts,
	resolveDownloadTarget,
} from "../downloadTarget";
import {
	type DeploymentScope,
	foldDeploymentAttempt,
	readReachedDeploymentTargets,
	recordRemoteResource,
} from "../store";

vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));
vi.mock("../store", async (original) => {
	const store = await original<typeof import("../store")>();
	return {
		...store,
		readReachedDeploymentTargets: vi.fn(store.readReachedDeploymentTargets),
	};
});

const h = setupAppStateTestDb("download_targets_", { authSchema: "migrated" });
const APP = "download-app";
const PROJECT = "clinic";
const AT = "2026-09-01T00:00:00.000Z";
const OWNER: DeploymentScope = {
	appId: APP,
	projectId: PROJECT,
	role: "owner",
	actorUserId: "creator",
};

function signedInAs(userId: string) {
	vi.mocked(getSession).mockResolvedValue({ user: { id: userId } } as never);
}
async function seed(doc: BlueprintDoc) {
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		projectId: PROJECT,
		owner: "creator",
	});
	await h.seedProjectMember("creator", PROJECT, "owner");
	await h.seedProjectMember("viewer", PROJECT, "viewer");
}
async function publish(
	server: "india" | "production",
	domain: string,
	adoptedBy?: string,
) {
	const target = { server, domain };
	await foldDeploymentAttempt(
		OWNER,
		target,
		"preflight",
		{ status: "succeeded", at: AT },
		{ ensure: true, expectedEndings: 0 },
	);
	return recordRemoteResource(OWNER, target, {
		expectedEndings: 0,
		kind: "app",
		novaResourceId: APP,
		remoteId: `${server}-${domain}-app`,
		ownership: adoptedBy === undefined ? "nova-created" : "adopted",
		...(adoptedBy !== undefined && { adoptedBy }),
		pushedRevision: 0,
		remoteRevision: 1,
		uploadedAt: AT,
		baseline: {
			origin: "unread",
			remoteAppId: `${server}-${domain}-app`,
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: AT,
			discard: null,
			novaRevision: null,
			mediaFiles: { kind: "set", files: null },
			firstPublish: { kind: "set", list: null },
		},
	});
}
const plainDoc = () =>
	buildDoc({
		appName: "Clinic intake",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ id: "note", kind: "text" }],
					},
				],
			},
		],
	});

beforeEach(() => signedInAs("viewer"));

it("refuses a caller outside the app's Project as not found, reading no deployment", async () => {
	await seed(plainDoc());
	await publish("india", "clinic");
	signedInAs("outsider");
	expect(await readDownloadTargetsAction(APP)).toMatchObject({
		success: false,
		code: "not_found",
	});
	expect(readReachedDeploymentTargets).not.toHaveBeenCalled();
});

it("gives a viewer every reached project space and no lines", async () => {
	await seed(plainDoc());
	await publish("india", "clinic");
	await publish("production", "training");
	const result = await readDownloadTargetsAction(APP);
	expect(result).toEqual({
		success: true,
		data: {
			targets: expect.arrayContaining([
				{ server: "india", domain: "clinic" },
				{ server: "production", domain: "training" },
			]),
			heldFromHq: [],
			webAppsOnly: false,
		},
	});
	if (result.success) expect(result.data.targets).toHaveLength(2);
	expect(readReachedDeploymentTargets).toHaveBeenCalledOnce();
});

/* Each selection CommCare HQ cannot take chooses several cases, which
 * Android can't run, so an app that holds one runs in Web Apps only and has
 * no CCZ anywhere: the dialog says so rather than naming its menus. */
it.each(["parent-multiple", "same-smaller"] as const)(
	"offers no CCZ target for a Web-Apps-only app (%s) and says why, whatever it reached",
	async (scenario) => {
		await seed(nestedMenuWireFixture(scenario));
		for (const reach of [false, true]) {
			if (reach) await publish("india", "clinic");
			expect(await readDownloadTargetsAction(APP)).toEqual({
				success: true,
				data: { targets: [], heldFromHq: [], webAppsOnly: true },
			});
		}
		expect(readReachedDeploymentTargets).not.toHaveBeenCalled();
	},
);

it("gives no lines for an app published nowhere that CommCare HQ can take", async () => {
	await seed(plainDoc());
	expect(await readDownloadTargetsAction(APP)).toEqual({
		success: true,
		data: { targets: [], heldFromHq: [], webAppsOnly: false },
	});
});

it("makes a CCZ for the project space an app was brought in from under HQ's media paths and case id prefixes, and for another under none", async () => {
	const doc = caseOperationFixture("key");
	await seed(doc);
	const brought = await publish("india", "clinic");
	await publish("india", "district");
	const keyed = Object.entries(doc.forms).flatMap(([formUuid, form]) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			operation.action === "create" &&
			operation.target.kind === "new" &&
			operation.target.idFrom !== undefined
				? [{ formUuid, operation }]
				: [],
		),
	);
	const [{ formUuid, operation }] = keyed;
	if (operation.action !== "create") throw new Error("Expected a create");
	const prefix = authoredCaseIdPrefix({
		appId: "hq-source-app",
		formUuid: asUuid(formUuid),
		operationUuid: operation.uuid,
		caseType: operation.caseType,
	});
	const image = testMediaAssetId("brought-image");
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: image,
			project_id: PROJECT,
			owner: "creator",
			kind: "image",
			content_hash: "c".repeat(64),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 256,
			gcs_object_key: `projects/${PROJECT}/brought.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: "ready",
			media_format: "png",
		})
		.execute();
	await h
		.db()
		.insertInto("app_deployment_media_paths")
		.values({
			deployment_id: brought.deployment.id,
			media_asset_id: image,
			wire_path: "media/logo.png",
		})
		.execute();
	await h
		.db()
		.insertInto("app_deployment_keyed_case_ids")
		.values({
			deployment_id: brought.deployment.id,
			nova_operation_uuid: operation.uuid,
			case_type: operation.caseType,
			case_id_prefix: prefix,
		})
		.execute();

	const clinic = await resolveDownloadTarget(OWNER, {
		format: "ccz",
		server: "india",
		domain: "clinic",
		doc,
	});
	if ("kind" in clinic || clinic.format !== "ccz")
		throw new Error(JSON.stringify(clinic));
	expect([...clinic.mediaPaths]).toEqual([[image, "media/logo.png"]]);
	expect([...clinic.keyedCaseIdPrefixes]).toEqual([[operation.uuid, prefix]]);

	const district = await resolveDownloadTarget(OWNER, {
		format: "ccz",
		server: "india",
		domain: "district",
		doc,
	});
	if ("kind" in district || district.format !== "ccz")
		throw new Error(JSON.stringify(district));
	expect(district.mediaPaths.size).toBe(0);
	expect(district.keyedCaseIdPrefixes.size).toBe(0);
});

it("makes a CCZ that seeds nothing for a project space an app was brought in from whose read-back did not land, and says its language names may differ", async () => {
	const doc = plainDoc();
	await seed(doc);
	await publish("india", "clinic", "creator");
	await publish("india", "district");

	const clinic = await resolveDownloadTarget(OWNER, {
		format: "ccz",
		server: "india",
		domain: "clinic",
		doc,
	});
	if ("kind" in clinic || clinic.format !== "ccz")
		throw new Error(JSON.stringify(clinic));
	expect(clinic.targetFacts).toBeNull();
	expect(clinic.target.adopted).toBe(true);
	expect(downloadKeptAdvisoryFacts(clinic, doc)).toEqual({
		uiTextFallsBack: false,
		androidLogos: false,
		practiceWorker: false,
		languageNames: true,
	});

	const district = await resolveDownloadTarget(OWNER, {
		format: "ccz",
		server: "india",
		domain: "district",
		doc,
	});
	if ("kind" in district || district.format !== "ccz")
		throw new Error(JSON.stringify(district));
	expect(district.targetFacts).toBeNull();
	expect(district.target.adopted).toBe(false);
	expect(downloadKeptAdvisoryFacts(district, doc)).toBeNull();
});
