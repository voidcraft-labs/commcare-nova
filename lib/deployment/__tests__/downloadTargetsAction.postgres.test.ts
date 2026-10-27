/**
 * The publish dialog's read of where a CCZ can be made for, against real
 * Postgres: the Project gate, the ledger's reached deployments, the lines
 * the stored document gives when no project space holds the app, and no
 * target at all for an app that does not declare Android.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { getSession } from "@/lib/auth-utils";
import { nestedMenuWireFixture } from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc } from "@/lib/domain";
import { readDownloadTargetsAction } from "../actions";
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
async function publish(server: "india" | "production", domain: string) {
	const target = { server, domain };
	await foldDeploymentAttempt(
		OWNER,
		target,
		"preflight",
		{ status: "succeeded", at: AT },
		{ ensure: true },
	);
	await recordRemoteResource(OWNER, target, {
		kind: "app",
		novaResourceId: APP,
		remoteId: `${server}-${domain}-app`,
		ownership: "nova-created",
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
