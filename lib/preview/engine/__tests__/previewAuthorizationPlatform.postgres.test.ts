/** The device a Preview request names is admitted against the committed
 * app's platforms: real app birth and a real committed declaration, with only
 * the authenticated request session supplied at its external boundary. */
import { beforeEach, expect, it, vi } from "vitest";
import { applyBlueprintChangeProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import {
	PLATFORM_UNAVAILABLE_MESSAGE,
	resolveAuthorizedPreviewContext,
} from "../previewAuthorization";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const ACTOR = "platform-admission-actor";
const PROJECT = "platform-admission-project";
vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: {
			id: "platform-admission-actor",
			name: "Amara",
			email: "amara@dimagi.com",
		},
	}),
}));
const h = setupAppStateTestDb("preview_platform_admission_", {
	authSchema: "migrated",
	poolMax: 4,
});
beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
});

async function androidOnlyApp(): Promise<string> {
	const birth = await createExplicitBlankApp(
		ACTOR,
		PROJECT,
		crypto.randomUUID(),
	);
	await applyBlueprintChangeProposal({
		appId: birth.appId,
		userId: ACTOR,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: {
			mutations: [
				{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
			],
		},
	});
	return birth.appId;
}

it("refuses a Web Apps device for an app that runs only on Android", async () => {
	const appId = await androidOnlyApp();
	const context = await resolveAuthorizedPreviewContext({
		appId,
		required: "view",
		loadBlueprint: true,
		device: webAppsDevice(),
	});
	expect(context).toEqual({
		kind: "platform-unavailable",
		message: PLATFORM_UNAVAILABLE_MESSAGE,
	});
});

it("admits an Android device and carries it on the ready context", async () => {
	const appId = await androidOnlyApp();
	const device = androidDevice();
	const context = await resolveAuthorizedPreviewContext({
		appId,
		required: "view",
		loadBlueprint: true,
		device,
	});
	if (context.kind !== "ready")
		throw new Error(`Preview refused: ${context.kind}`);
	expect(context.device).toEqual(device);
});

it("refuses a device in a shape it cannot read before reading the app", async () => {
	const appId = await androidOnlyApp();
	await expect(
		resolveAuthorizedPreviewContext({
			appId,
			required: "view",
			loadBlueprint: true,
			device: { ...androidDevice(), windowWidth: 1280 },
		}),
	).rejects.toThrow(
		"Preview sent the device it runs on in a shape it cannot read.",
	);
});
