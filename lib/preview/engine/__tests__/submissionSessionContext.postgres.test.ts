/** A case operation writing the device's id stores the id of the platform
 * Preview plays, through the submission Server Action's own program: real
 * app storage, authorization and case writes, with only the authenticated
 * request session supplied at its external boundary. */
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	ANDROID_DEVICE_ID_PREFIX,
	WEB_APPS_DEVICE_ID,
} from "@/lib/preview/platform";
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
	}),
}));
const h = setupAppStateTestDb("submission_session_context_", {
	authSchema: "migrated",
	poolMax: 4,
});
beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
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

async function submitOn(device: PreviewDevice): Promise<unknown> {
	const { appId } = await deviceRecordApp();
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
	const result = await submitFormAction(
		engine.computeSubmissionMutation({ entryKey: crypto.randomUUID() }),
		appId,
		canonicalJsonDigest(stored),
		undefined,
		undefined,
		undefined,
		device,
	);
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
