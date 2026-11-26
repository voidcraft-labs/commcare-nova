/** A case operation writing the device's id stores the id of the platform
 * Preview plays, through the submission Server Action's own program: real
 * app storage, authorization and case writes, with only the authenticated
 * request session supplied at its external boundary. */
import { sql } from "kysely";
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	readAuthorizedPreviewSearchCatalog,
	setPreviewSearchSettings,
} from "@/lib/deployment/previewSearchSettings";
import { endDeployment } from "@/lib/deployment/store";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	ANDROID_DEVICE_ID_PREFIX,
	WEB_APPS_DEVICE_ID,
} from "@/lib/preview/platform";
import { resolvePreviewSearchFacts } from "@/lib/preview/searchSettings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { submitFormAction } from "../caseDataBinding";
import { FormEngine } from "../formEngine";
import { resolveAuthorizedPreviewContext } from "../previewAuthorization";
import type { PreviewDevice } from "../previewDevice";
import { createEvaluationApp } from "./evaluationFixture";
import {
	androidDevice,
	TEST_ANDROID_DEVICE_ID,
	webAppsDevice,
} from "./fixtures/previewDevices";

const ACTOR = "device-id-writer";
const PROJECT = "device-id-project";
vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: { id: "device-id-writer", name: "Amara", email: "amara@dimagi.com" },
		session: { id: "device-id-writer-session" },
	}),
}));
const h = setupAppStateTestDb("submission_session_context_", {
	authSchema: "migrated",
	poolMax: 4,
});
beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	// The live browser session every Project data read locks.
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt")
		VALUES ('device-id-writer-session','device-id-token',${ACTOR},now()+interval '1 hour',now(),now())
		ON CONFLICT (id) DO NOTHING`.execute(h.db());
});

async function deviceRecordApp() {
	const doc = await createEvaluationApp(
		[
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Register", type: "registration" }],
			},
		],
		[
			{
				toolName: "addCaseOperations",
				input: {
					moduleUuid: "Visits",
					formUuid: "Register",
					operations: [
						{
							operation: {
								id: "device_record",
								action: "create",
								caseType: "visit",
								target: { kind: "new" },
								name: "'Device record'",
								writes: [
									{
										property: "device",
										value: "session('deviceid')",
									},
								],
							},
						},
					],
				},
			},
		],
	);
	const appId = await h.seedAppWithBlueprint(doc, {
		owner: ACTOR,
		projectId: PROJECT,
	});
	return { appId, doc };
}

async function openRegistration(appId: string, device: PreviewDevice) {
	const context = await resolveAuthorizedPreviewContext({
		appId,
		required: "edit",
		loadBlueprint: true,
		device,
	});
	if (context.kind !== "ready" || context.blueprint === undefined)
		throw new Error(`Preview refused: ${context.kind}`);
	/* The stored document, as the submission checks it. */
	const stored = context.blueprint;
	const doc = hydratePersistedBlueprint(stored);
	const form = Object.values(doc.forms).find(
		(item) => item.name === "Register",
	);
	if (!form) throw new Error("Missing the registration form.");
	const engine = new FormEngine(
		{
			doc,
			form,
			formUuid: form.uuid,
			fields: doc.fields,
			fieldOrder: doc.fieldOrder,
			caseTypes: doc.caseTypes ?? [],
			userProperties: doc.userProperties,
		},
		"visit",
		undefined,
		context.identity,
		undefined,
		undefined,
		{ device },
	);
	for (const field of Object.values(doc.fields))
		if (field.kind === "text") engine.setValue(`/data/${field.id}`, "Asha");
	const mutation = engine.computeSubmissionMutation({
		entryKey: crypto.randomUUID(),
	});
	return {
		projectSpace: context.identity.session.user.commcare_project,
		submit: () =>
			submitFormAction(
				mutation,
				appId,
				canonicalJsonDigest(stored),
				undefined,
				undefined,
				undefined,
				device,
			),
	};
}

async function submitOn(device: PreviewDevice): Promise<unknown> {
	const { appId } = await deviceRecordApp();
	const entry = await openRegistration(appId, device);
	const result = await entry.submit();
	if (result.kind === "blueprint-changed" || result.kind === "unauthenticated")
		throw new Error(JSON.stringify(result));
	const rows = await h
		.pool()
		.query(
			"SELECT properties FROM cases WHERE app_id = $1 AND case_name = 'Device record'",
			[appId],
		);
	expect(rows.rows).toHaveLength(1);
	return rows.rows[0].properties.device;
}

it("stores Formplayer's device id through a Web Apps device", async () => {
	expect(await submitOn(webAppsDevice())).toBe(WEB_APPS_DEVICE_ID);
});

it("stores the Android install's device id through an Android device", async () => {
	expect(await submitOn(androidDevice())).toBe(
		`${ANDROID_DEVICE_ID_PREFIX}${TEST_ANDROID_DEVICE_ID}`,
	);
});

it("refuses stale destination effects while allowing an exact receipt replay", async () => {
	const { appId } = await deviceRecordApp();
	const scope = {
		appId,
		projectId: PROJECT,
		role: "owner",
		actorUserId: ACTOR,
	} as const;
	const target = {
		kind: "destination",
		server: "eu",
		domain: "clinic",
	} as const;
	const remoteId = "e".repeat(32);
	await sql`
		WITH deployed AS (
			INSERT INTO app_deployments (app_id, project_id, server, domain, state, created_by)
			VALUES (${appId}, ${PROJECT}, ${target.server}, ${target.domain}, 'uploaded', ${ACTOR})
			RETURNING id
		)
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id, ownership)
		SELECT id, 'app', ${appId}, ${remoteId}, 'nova-created' FROM deployed
	`.execute(h.db());
	const selectedDevice = async () => {
		const catalog = await readAuthorizedPreviewSearchCatalog(
			appId,
			PROJECT,
			ACTOR,
		);
		return {
			...webAppsDevice(),
			searchConfiguration: {
				target,
				revision: resolvePreviewSearchFacts(catalog, target).revision,
			},
		};
	};
	const originalDevice = await selectedDevice();
	const saved = await openRegistration(appId, originalDevice);
	const staleSettings = await openRegistration(appId, originalDevice);
	expect(saved.projectSpace).toBe(target.domain);
	const receipt = await saved.submit();
	if (receipt.kind !== "registration") throw new Error(JSON.stringify(receipt));
	expect(
		await setPreviewSearchSettings(scope, ACTOR, target, "0", {
			timeZone: "UTC",
		}),
	).toMatchObject({ kind: "saved" });
	expect(await staleSettings.submit()).toMatchObject({
		kind: "error",
		message: expect.stringContaining("project space changed"),
	});
	const staleDeployment = await openRegistration(appId, await selectedDevice());
	expect(staleDeployment.projectSpace).toBe(target.domain);
	await endDeployment(scope, target, remoteId);
	expect(await staleDeployment.submit()).toMatchObject({
		kind: "error",
		message: expect.stringContaining("project space changed"),
	});
	expect(await saved.submit()).toEqual(receipt);
	const undeployed = await openRegistration(appId, webAppsDevice());
	expect(undeployed.projectSpace).toBeUndefined();
	const localReceipt = await undeployed.submit();
	if (localReceipt.kind !== "registration")
		throw new Error(JSON.stringify(localReceipt));
	const rows = await h
		.pool()
		.query<{ case_id: string }>(
			"SELECT case_id FROM cases WHERE app_id = $1 AND case_name = 'Device record'",
			[appId],
		);
	const effectIds = [receipt, localReceipt].flatMap((result) =>
		(result.caseDatabasePatch?.rows ?? [])
			.filter((row) => row.case_name === "Device record")
			.map((row) => row.case_id),
	);
	expect(effectIds).toHaveLength(2);
	expect(rows.rows.map((row) => row.case_id).sort()).toEqual(effectIds.sort());
});
