import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { PublishResponseBody } from "@/components/builder/publishOutcome";
import { endpointWireFixture } from "@/lib/commcare/__tests__/endpointWireFixture";
import type { DeploymentView } from "@/lib/deployment/actions";
import {
	APP_PREVIEW_NOTE,
	BASELINE_UNKNOWN_SENTENCE,
	HQ_CHANGED_MESSAGE,
} from "@/lib/deployment/remoteChanges";
import { buildSetupArtifact } from "@/lib/deployment/setupArtifact";
import {
	type DeploymentConfirmationNeeded,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "@/lib/deployment/types";
import {
	encodeManualImportGuide,
	MANUAL_IMPORT_GUIDE_HEADER,
	manualImportGuide,
} from "@/lib/publish/manualImportGuide";
import {
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	LOGO_UPLOAD_STEP_TEXT,
	PLAN_FEATURES,
	webAppsOffText,
} from "@/lib/publish/planFeatures";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	PROJECT_SPACE_CAPABILITIES,
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
} from "@/lib/publish/projectSpaceCompatibility";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/publishing-client.tsx", [], {
		"@/lib/deployment/actions": resolve("e2e/lib/publishing-boundary.ts"),
		"@/lib/lookup/actions": resolve("e2e/lib/publishing-boundary.ts"),
	});
});
test.afterAll(async () => {
	await peer?.close();
});
function report(
	domain = "alpha",
	blocked = false,
): ProjectSpaceCompatibilityReport {
	const capability = {
		...PROJECT_SPACE_CAPABILITIES["case-search"],
		reasons: ["Patients searches cases."],
		state: blocked ? ("missing" as const) : ("available" as const),
	};
	return {
		status: blocked ? "blocked" : "ready",
		target_domain: domain,
		required_capabilities: [capability],
		blockers: blocked ? [capability] : [],
		advisories: [],
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message: blocked
			? "This project space does not support Case search."
			: "This project space supports everything this app uses.",
	};
}
async function open(page: Page, query = "") {
	await page.route("**/api/apps/native-publishing/stream?*", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: "retry: 3600000\n\n",
		}),
	);
	await page.route("**/api/apps/native-publishing/presence", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/publishing/lookup", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: { projectId: "native-project", revision: "0", tables: [] },
			},
		}),
	);
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [] } }),
	);
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					targets: [{ server: "india", domain: "alpha" }],
					heldFromHq: [],
				},
			},
		}),
	);
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: {
				ok: true,
				report: report(
					new URL(route.request().url()).searchParams.get("domain") ||
						undefined,
				),
			},
		}),
	);
	await page.goto(`${peer.origin}/?${query}`);
	if (!query.includes("links=true"))
		await page
			.getByRole("button", { name: "Open publish", exact: true })
			.click();
}
async function choose(page: Page, label: string, name: string) {
	await page.getByRole("combobox", { name: label, exact: true }).click();
	await page.getByRole("option", { name, exact: true }).click();
}
const refusal = {
	success: false,
	refusal: {
		phase: "resources",
		failure: {
			code: "hq_resource_conflict",
			message: "An existing table needs your choice.",
			details: [],
		},
		resourceConflicts: [
			{
				kind: "lookup-table",
				novaResourceId: "table-one",
				name: "Clinics",
				identity: "clinics",
				remoteId: "remote-clinics",
			},
		],
		remoteChanges: [],
		confirmationsNeeded: [],
	},
	preview_project_space: null,
} satisfies PublishResponseBody;
test("native publish consent expires when the dialog closes or its destination changes", async ({
	page,
}) => {
	const sent: unknown[] = [];
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({ json: refusal });
	});
	await open(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await page.getByRole("checkbox", { name: "Clinics (clinics)" }).check();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toMatchObject({ adopt_resources: [] });
	await page.getByRole("checkbox", { name: "Clinics (clinics)" }).check();
	await choose(page, "Publish option", "CommCare HQ app file");
	await choose(page, "Publish option", "CommCare HQ");
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	expect(sent[2]).toMatchObject({ adopt_resources: [] });
});
test("native publish lists what changed in CommCare HQ, publishes over each ticked change as it was shown, and lands with the App Preview line", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	const remoteChanges = [
		{
			kind: "app",
			novaResourceId: "native-publishing",
			name: "Clinic visits",
			identity: "hq-app",
			parts: ["The form Visit in the menu Patients", "The app's name"],
			note: null,
			observedDigest: "digest-app",
			baselineKnown: true,
		},
		{
			kind: "location",
			novaResourceId: "place-north",
			name: "North",
			identity: "north",
			parts: [],
			note: null,
			observedDigest: "digest-north",
			baselineKnown: false,
		},
	] as const;
	const changed = {
		success: false,
		refusal: {
			phase: "preflight",
			failure: {
				code: "hq_changed",
				message: HQ_CHANGED_MESSAGE,
				details: ["Clinic visits", "North"],
			},
			resourceConflicts: [],
			remoteChanges: [...remoteChanges],
			confirmationsNeeded: [],
		},
		preview_project_space: null,
	} satisfies PublishResponseBody;
	const landed = {
		success: true,
		hq_app_action: "updated",
		app_preview_note: APP_PREVIEW_NOTE,
		url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
		warnings: [],
		deployment: null,
		preview_project_space: "alpha",
	} satisfies PublishResponseBody;
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({ json: sent.length === 1 ? changed : landed });
	});
	await open(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText("The form Visit in the menu Patients", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("The app's name", { exact: true })).toBeVisible();
	await expect(
		page.getByText(BASELINE_UNKNOWN_SENTENCE, { exact: true }),
	).toBeVisible();
	const publishOver = page.getByRole("button", {
		name: "Publish over these changes",
		exact: true,
	});
	await expect(publishOver).toBeDisabled();
	await page
		.getByRole("checkbox", { name: "Publish over this Clinic visits" })
		.check();
	await expect(publishOver).toBeDisabled();
	await page.getByRole("checkbox", { name: "Publish over this North" }).check();
	await publishOver.click();
	await expect(page.getByText(APP_PREVIEW_NOTE, { exact: true })).toBeVisible();
	expect(sent).toHaveLength(2);
	expect(sent[0]).toMatchObject({ discard_remote_changes: [] });
	expect(sent[1].discard_remote_changes).toEqual([
		{
			kind: "app",
			novaResourceId: "native-publishing",
			observedDigest: "digest-app",
		},
		{
			kind: "location",
			novaResourceId: "place-north",
			observedDigest: "digest-north",
		},
	]);
});
test("native released links preserve external selection order and recheck before copying", async ({
	page,
	context,
}) => {
	const calls: unknown[] = [];
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.route("**/publishing/link", (route) => {
		calls.push(route.request().postDataJSON());
		return route.fulfill({
			json:
				calls.length === 1
					? {
							success: true,
							data: {
								url: "https://india.commcarehq.org/link/first",
								checkedAt: "2026-09-06T00:00:00Z",
							},
						}
					: {
							success: false,
							message:
								"The released build changed. Check it again after publishing.",
						},
		});
	});
	await open(page, "links=true");
	await page
		.getByRole("button", { name: "Patients · Visit", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "patient case IDs", exact: true })
		.fill(" hq-second \n\nhq-first");
	await page
		.getByRole("button", { name: "Generate HQ link", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
	).toHaveValue("https://india.commcarehq.org/link/first");
	expect(calls[0]).toMatchObject({
		appId: "native-publishing",
		server: "india",
		domain: "alpha",
		selections: [{ caseIds: ["hq-second", "hq-first"] }],
	});
	await page.evaluate(() => navigator.clipboard.writeText("keep clipboard"));
	await page.getByRole("button", { name: "Copy HQ link", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("released build changed");
	await expect(
		page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
	).toHaveCount(0);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"keep clipboard",
	);
	await expect(
		page.getByRole("textbox", { name: "patient case IDs", exact: true }),
	).toHaveValue(" hq-second \n\nhq-first");
});

test("native publish checks each selected Project and holds a server refusal until a fresh check", async ({
	page,
}) => {
	const checked: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/publishing/compatibility?"))
			checked.push(new URL(request.url()).searchParams.get("domain") ?? "");
	});
	await open(page, "multi=true");
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	expect(checked).toEqual([]);
	await choose(page, "Project space", "Alpha");
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	expect(checked).toEqual(["alpha"]);
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: { ...refusal, project_space_compatibility: report("alpha", true) },
		}),
	);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByText("“Alpha” needs more support to run the app", {
			exact: true,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	await choose(page, "Project space", "Beta");
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	expect(checked).toEqual(["alpha", "alpha", "beta"]);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
});

test("native file downloads remain available to viewers and ignore a completion from an older dialog", async ({
	page,
}) => {
	let held: import("@playwright/test").Route | undefined;
	await page.route("**/api/compile/json", (route) => {
		held = route;
	});
	await page.route("**/publishing/download/ccz?*", (route) =>
		route.fulfill({ json: { ok: true } }),
	);
	try {
		await open(page, "viewer=true");
		await page
			.getByRole("combobox", { name: "Publish option", exact: true })
			.click();
		await expect(
			page.getByRole("option", { name: "CommCare HQ", exact: true }),
		).toHaveCount(0);
		await page
			.getByRole("option", { name: "CommCare HQ app file", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Download ZIP", exact: true })
			.click();
		await expect.poll(() => Boolean(held)).toBe(true);
		await expect(
			page.getByRole("button", { name: "Preparing", exact: true }),
		).toBeDisabled();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page
			.getByRole("button", { name: "Open publish", exact: true })
			.click();
		const old = held;
		held = undefined;
		await old?.fulfill({ body: "zip", contentType: "application/zip" });
		await expect(
			page.getByRole("button", { name: "Download ZIP", exact: true }),
		).toBeEnabled();
		await expect(
			page.getByText("CommCare HQ app file downloaded", { exact: true }),
		).toHaveCount(0);
		await choose(page, "Publish option", "CommCare mobile app file");
		await page
			.getByRole("button", { name: "Download CCZ", exact: true })
			.click();
		await expect(
			page.getByText("Mobile app file downloaded", { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Done", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Open publish", exact: true }),
		).toBeFocused();
	} finally {
		await held?.abort();
		await page.goto("about:blank");
	}
});

test("native compatibility transport failure preserves downloads and an explicit retry restores upload", async ({
	page,
}) => {
	await open(page);
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: { ok: false, message: "Nova could not check this project space." },
		}),
	);
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(
		page.getByText("Nova could not check this project space.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeDisabled();
	await choose(page, "Publish option", "CommCare HQ app file");
	await expect(
		page.getByRole("button", { name: "Download ZIP", exact: true }),
	).toBeEnabled();
	await choose(page, "Publish option", "CommCare HQ");
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({ json: { ok: true, report: report() } }),
	);
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
});

test("native released links wait for actual human save authority and discard a response after destination change", async ({
	page,
}) => {
	let put: import("@playwright/test").Route | undefined;
	let link: import("@playwright/test").Route | undefined;
	await page.route("**/api/apps/native-publishing", (route) => {
		put = route;
	});
	await page.route("**/publishing/link", (route) => {
		link = route;
	});
	try {
		await open(page, "links=true");
		await page
			.getByRole("button", { name: "Patients · Visit", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "patient case IDs", exact: true })
			.fill("hq-one");
		await page
			.getByRole("button", { name: "Edit document", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Generate HQ link", exact: true })
			.click();
		await expect.poll(() => Boolean(put)).toBe(true);
		expect(link).toBeUndefined();
		await expect(
			page.getByRole("button", {
				name: "Checking released build",
				exact: true,
			}),
		).toBeDisabled();
		const save = put;
		put = undefined;
		await save?.fulfill({ json: { seq: 1 } });
		await expect.poll(() => Boolean(link)).toBe(true);
		await page
			.getByRole("button", { name: "Change deployment target", exact: true })
			.click();
		const old = link;
		link = undefined;
		await old?.fulfill({
			json: {
				success: true,
				data: {
					url: "https://india.commcarehq.org/old",
					checkedAt: "2026-09-06T00:00:00Z",
				},
			},
		});
		await expect(
			page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Generate HQ link", exact: true }),
		).toBeEnabled();
	} finally {
		await put?.abort();
		await link?.abort();
		await page.goto("about:blank");
	}
});

test("native released link viewers retain the destination without verification writes", async ({
	page,
}) => {
	const calls: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/publishing/link")) calls.push(request.url());
	});
	await open(page, "links=true&viewer=true");
	await page
		.getByRole("button", { name: "Patients · Visit", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "patient case IDs", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Generate HQ link", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText(
			"A Project editor can check the released build and generate a link",
			{ exact: true },
		),
	).toBeVisible();
	expect(calls).toEqual([]);
});

test("native released links discard old document responses and old destination refusals", async ({
	page,
}) => {
	const held: { route: import("@playwright/test").Route | undefined } = {
		route: undefined,
	};
	const takeHeld = () => {
		const route = held.route;
		held.route = undefined;
		return route;
	};
	await page.route("**/publishing/link", (route) => {
		held.route = route;
	});
	try {
		await open(page, "links=true");
		await page
			.getByRole("button", { name: "Patients · Visit", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "patient case IDs", exact: true })
			.fill("hq-one");
		await page
			.getByRole("button", { name: "Generate HQ link", exact: true })
			.click();
		await expect.poll(() => Boolean(held.route)).toBe(true);
		await page
			.getByRole("button", { name: "Edit document", exact: true })
			.click();
		const old = takeHeld();
		await old?.fulfill({
			json: {
				success: true,
				data: {
					url: "https://india.commcarehq.org/stale",
					checkedAt: "2026-09-06T00:00:00Z",
				},
			},
		});
		await expect(
			page.getByRole("textbox", { name: "CommCare HQ deep link", exact: true }),
		).toHaveCount(0);
		// The next request waits for the actual mutation PUT before it reaches HQ.
		await page.route("**/api/apps/native-publishing", (route) =>
			route.fulfill({ json: { seq: 1 } }),
		);
		await page
			.getByRole("button", { name: "Generate HQ link", exact: true })
			.click();
		await expect.poll(() => Boolean(held.route)).toBe(true);
		const fresh = takeHeld();
		await fresh?.fulfill({
			json: { success: false, message: "Alpha has no released build." },
		});
		await expect(page.getByRole("alert")).toHaveText(
			"Alpha has no released build.",
		);
		await page
			.getByRole("button", { name: "Change deployment target", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveCount(0);
	} finally {
		await held.route?.abort();
		await page.goto("about:blank");
	}
});

test("native publish to the empty app an earlier try made says it fills it in, and lands as a new app", async ({
	page,
}) => {
	const doc = endpointWireFixture("multiple");
	/* A first publish that stopped after HQ made the empty app: its mapping
	 * is live and carries no pushed revision. */
	const shell: DeploymentView = {
		deployment: {
			deployment: {
				id: "deployment",
				appId: "native-publishing",
				projectId: "native-project",
				server: "production",
				domain: "alpha",
				state: "incomplete",
				resumePhase: "resources",
				phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
				createdBy: "native-user",
				createdAt: "2026-09-06T00:00:00Z",
				updatedAt: "2026-09-06T00:00:00Z",
				lastObservedAt: null,
				offeredLogoContentHash: null,
				targetEmptyCaseListText: null,
				targetWebAppsEnabled: null,
			},
			active: [
				{
					deploymentId: "deployment",
					kind: "app",
					novaResourceId: "native-publishing",
					remoteId: "hq-shell",
					ownership: "nova-created",
					pushedIdentity: null,
					adoptedAt: null,
					adoptedBy: null,
					pushedRevision: null,
					pushedAt: null,
					pushToken: "shell-token",
					remoteRevision: null,
					remoteObservedAt: null,
					supersededAt: null,
					remoteMissingAt: null,
				},
			],
			superseded: [],
			confirmations: [],
		},
		artifact: buildSetupArtifact({
			doc,
			server: "production",
			domain: "alpha",
			hqAppId: null,
			locations: [],
			targetWebAppsEnabled: null,
		}),
		leftBehind: [],
	};
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: true,
				hq_app_action: "created",
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-shell/",
				warnings: [],
				deployment: null,
				preview_project_space: "alpha",
			} satisfies PublishResponseBody,
		}),
	);
	await open(page);
	/* The dialog reads where the app stands each time it opens; this answer
	 * is registered after open's, so it is the one the second opening reads. */
	await page.route("**/publishing/read", (route) =>
		route.fulfill({ json: { success: true, data: [shell] } }),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await expect(
		page.getByText(
			"Nova made an empty app here on an earlier try. Uploading fills it in.",
			{ exact: true },
		),
	).toBeVisible();
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText("Your app is on CommCare HQ", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Your app is updated on CommCare HQ", { exact: true }),
	).toHaveCount(0);
});

test("native CCZ download is made for a project space the app is published to", async ({
	page,
}) => {
	const asked: { server: string | null; domain: string | null }[] = [];
	await page.route("**/publishing/download/ccz?*", (route) => {
		const url = new URL(route.request().url());
		asked.push({
			server: url.searchParams.get("server"),
			domain: url.searchParams.get("domain"),
		});
		return route.fulfill({ json: { ok: true } });
	});
	async function targets(
		data: { targets: unknown[]; heldFromHq: string[] },
		query = "",
	) {
		await open(page, query);
		await page.route("**/publishing/download-targets", (route) =>
			route.fulfill({ json: { success: true, data } }),
		);
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: "Open publish", exact: true })
			.click();
		await choose(page, "Publish option", "CommCare mobile app file");
	}

	await targets({ targets: [], heldFromHq: [] });
	await expect(
		page.getByText(
			"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. Once the app is published, you can download the CCZ for that space.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Publish to CommCare HQ", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeVisible();

	const held = [
		'CommCare HQ can\'t yet find the cases for "Child care" from several cases selected in "Parents".',
	];
	await targets({ targets: [], heldFromHq: held });
	await expect(
		page.getByText(
			"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. This app can't be published to CommCare HQ as it is, so it has no CCZ yet.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(page.getByText(held[0], { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Publish to CommCare HQ", exact: true }),
	).toHaveCount(0);

	await targets({
		targets: [{ server: "india", domain: "alpha" }],
		heldFromHq: [],
	});
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveText("alpha on India");
	await page.getByRole("button", { name: "Download CCZ", exact: true }).click();
	await expect(
		page.getByText("Mobile app file downloaded", { exact: true }),
	).toBeVisible();
	expect(asked.at(-1)).toEqual({ server: "india", domain: "alpha" });

	await targets({
		targets: [
			{ server: "india", domain: "alpha" },
			{ server: "production", domain: "alpha" },
		],
		heldFromHq: [],
	});
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toBeDisabled();
	await choose(page, "Project space", "alpha on US");
	await page.getByRole("button", { name: "Download CCZ", exact: true }).click();
	await expect(
		page.getByText("Mobile app file downloaded", { exact: true }),
	).toBeVisible();
	expect(asked.at(-1)).toEqual({ server: "production", domain: "alpha" });
});

test("native CCZ offers the project space a publish just reached, without reopening", async ({
	page,
}) => {
	await open(page);
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: { success: true, data: { targets: [], heldFromHq: [] } },
		}),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: true,
				hq_app_action: "created",
				url: "https://india.commcarehq.org/a/alpha/apps/view/hq-app/",
				warnings: [],
				deployment: null,
				preview_project_space: "alpha",
			} satisfies PublishResponseBody,
		}),
	);
	/* The publish lands on the space; the ledger now names it. */
	await page.route("**/publishing/download-targets", (route) =>
		route.fulfill({
			json: {
				success: true,
				data: {
					targets: [{ server: "india", domain: "alpha" }],
					heldFromHq: [],
				},
			},
		}),
	);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(
		page.getByText("Your app is on CommCare HQ", { exact: true }),
	).toBeVisible();
	await choose(page, "Publish option", "CommCare mobile app file");
	await expect(
		page.getByRole("combobox", { name: "Project space", exact: true }),
	).toHaveText("alpha on India");
	await expect(
		page.getByRole("button", { name: "Download CCZ", exact: true }),
	).toBeEnabled();
});

test("native import file download lists the guide's steps once the file arrives", async ({
	page,
}) => {
	const steps = manualImportGuide({
		appFileName: "Endpoint app",
		lookupTags: ["districts"],
		hasMedia: false,
		versionFloor: "2.57",
		capabilities: [],
		planFeatures: [],
		logo: null,
		readsLocations: false,
		sendsToConnect: false,
	});
	await page.route("**/api/compile/json", (route) =>
		route.fulfill({
			body: "zip",
			contentType: "application/zip",
			headers: {
				[MANUAL_IMPORT_GUIDE_HEADER]: encodeManualImportGuide(steps),
			},
		}),
	);
	await open(page, "viewer=true");
	await choose(page, "Publish option", "CommCare HQ app file");
	/* The field's description below the chosen option, not the option's own. */
	await expect(page.locator("#publish-target-description")).toHaveText(
		"Download a ZIP to import into CommCare HQ",
	);
	await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
	await expect(
		page.getByText("CommCare HQ app file downloaded", { exact: true }),
	).toBeVisible();
	const listed = page.getByRole("listitem").filter({
		has: page.getByText(steps[0].title, { exact: true }),
	});
	await expect(listed).toHaveCount(1);
	const titles = await page
		.locator("ol > li > p:first-child")
		.allTextContents();
	expect(titles).toEqual(steps.map((step) => step.title));
	await expect(
		page.getByText("This app needs CommCare 2.57 or later.", { exact: false }),
	).toBeVisible();
});

test("native import file download without a guide header still lands", async ({
	page,
}) => {
	await page.route("**/api/compile/json", (route) =>
		route.fulfill({ body: "zip", contentType: "application/zip" }),
	);
	await open(page, "viewer=true");
	await choose(page, "Publish option", "CommCare HQ app file");
	await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
	await expect(
		page.getByText("CommCare HQ app file downloaded", { exact: true }),
	).toBeVisible();
	await expect(page.locator("ol > li")).toHaveCount(0);
});

/** A deployment on alpha, as a landed publish answers with it. */
function landedView(
	confirmations: DeploymentView["deployment"]["confirmations"],
): DeploymentView {
	return {
		deployment: {
			deployment: {
				id: "deployment",
				appId: "native-publishing",
				projectId: "native-project",
				server: "production",
				domain: "alpha",
				state: "uploaded",
				resumePhase: null,
				phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
				createdBy: "native-user",
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-10-01T00:00:00Z",
				lastObservedAt: null,
				offeredLogoContentHash: null,
				targetEmptyCaseListText: null,
				targetWebAppsEnabled: true,
			},
			active: [],
			superseded: [],
			confirmations,
		},
		artifact: buildSetupArtifact({
			doc: endpointWireFixture("multiple"),
			server: "production",
			domain: "alpha",
			hqAppId: null,
			locations: [],
			targetWebAppsEnabled: null,
		}),
		leftBehind: [],
	};
}

test("native publish asks for each plan feature and project-space setting before the first press, holds Upload until each is ticked, and lands with the Web Apps line and the logo step", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	await open(page);
	/* Registered after open's, so it is the answer the next check reads. */
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: {
				ok: true,
				report: report("alpha"),
				confirmations: {
					plan_features: [
						{
							...PLAN_FEATURES["worker-records"],
							reasons: ["Visit reads worker information."],
							state: "needs_confirmation",
						},
					],
					flat_location_fixture: {
						label: FLAT_LOCATION_FIXTURE.label,
						consequence: FLAT_LOCATION_FIXTURE.consequence,
						reasons: [
							"Visit sets a case's owner from a place in your organization.",
						],
						state: "needs_confirmation",
					},
					connect_forwarder: {
						label: CONNECT_FORWARDER.label,
						consequence: CONNECT_FORWARDER.consequence,
						reasons: ["Visit sends a deliver unit to CommCare Connect."],
						state: "needs_confirmation",
					},
				},
			},
		}),
	);
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({
			json: {
				success: true,
				hq_app_action: "created",
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
				warnings: [],
				deployment: null,
				preview_project_space: "alpha",
				web_apps_enabled: false,
				logo_step: {
					assetId: "asset-logo",
					fileName: "logo.png",
					changed: true,
				},
			} satisfies PublishResponseBody,
		});
	});
	await page.route("**/api/media/asset-logo", (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/png",
			body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		}),
	);
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	const upload = page.getByRole("button", { name: "Upload", exact: true });
	await expect(
		page.getByText("Visit reads worker information.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(FLAT_LOCATION_FIXTURE.question("alpha"), { exact: true }),
	).toBeVisible();
	await expect(upload).toBeDisabled();
	await page
		.getByRole("checkbox", {
			name: "This project space has it Worker records (user cases)",
		})
		.check();
	await page
		.getByRole("checkbox", { name: "It still does The flat location list" })
		.check();
	await expect(upload).toBeDisabled();
	await page
		.getByRole("checkbox", { name: "It does A Connect forwarder" })
		.check();
	await expect(upload).toBeEnabled();
	await upload.click();
	await expect(
		page.getByText(webAppsOffText("alpha"), { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(LOGO_UPLOAD_STEP_TEXT, { exact: true }),
	).toBeVisible();
	expect(sent).toHaveLength(1);
	expect(sent[0].confirm).toEqual([
		{ kind: "plan-feature", subject: "worker-records" },
		{ kind: "flat-location-fixture" },
		{ kind: "connect-forwarder" },
	]);
	const download = page.waitForEvent("download");
	await page
		.getByRole("link", { name: "Download logo.png", exact: true })
		.click();
	expect((await download).suggestedFilename()).toBe("logo.png");
});

test("native publish answers a confirmation refusal with the same rows, and Withdraw on the record makes the next publish ask again", async ({
	page,
}) => {
	const sent: Record<string, unknown>[] = [];
	const withdrawn: Record<string, unknown>[] = [];
	const lookupTables: DeploymentConfirmationNeeded = {
		kind: "plan-feature",
		subject: "lookup-tables",
		label: PLAN_FEATURES["lookup-tables"].label,
		plans: PLAN_FEATURES["lookup-tables"].plans,
		consequence: PLAN_FEATURES["lookup-tables"].consequence,
		reasons: ["The app reads data from a lookup table."],
	};
	await page.route("**/api/commcare/upload", (route) => {
		sent.push(route.request().postDataJSON());
		return route.fulfill({
			json:
				sent.length === 1
					? ({
							success: false,
							refusal: {
								phase: "preflight",
								failure: {
									code: "hq_confirmation_needed",
									message:
										"“alpha” needs a few things Nova can't check from here. Once you confirm that the project space has each one below, publishing can continue.",
									details: [],
								},
								resourceConflicts: [],
								remoteChanges: [],
								confirmationsNeeded: [lookupTables],
							},
							preview_project_space: null,
						} satisfies PublishResponseBody)
					: ({
							success: true,
							hq_app_action: "created",
							url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
							warnings: [],
							deployment: landedView([
								{
									kind: "plan-feature",
									subject: "lookup-tables",
									confirmedByName: "Ada",
									confirmedAt: "2026-10-01T12:00:00Z",
								},
							]).deployment,
							setup_artifact: landedView([]).artifact,
							preview_project_space: "alpha",
							web_apps_enabled: true,
							logo_step: null,
						} satisfies PublishResponseBody),
		});
	});
	await page.route("**/publishing/withdraw", (route) => {
		withdrawn.push(route.request().postDataJSON());
		return route.fulfill({
			json: { success: true, data: landedView([]) },
		});
	});
	await open(page);
	const upload = page.getByRole("button", { name: "Upload", exact: true });
	await upload.click();
	const confirm = page.getByRole("checkbox", {
		name: "This project space has it Lookup Tables",
	});
	await expect(confirm).toBeVisible();
	await expect(upload).toBeDisabled();
	await confirm.check();
	await upload.click();
	expect(sent[0]).toMatchObject({ confirm: [] });
	expect(sent[1]).toMatchObject({
		confirm: [{ kind: "plan-feature", subject: "lookup-tables" }],
	});
	await expect(
		page.getByText(webAppsOffText("alpha"), { exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Withdraw Lookup Tables", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Withdraw Lookup Tables", exact: true }),
	).toHaveCount(0);
	expect(withdrawn).toEqual([
		{
			appId: "native-publishing",
			server: "production",
			domain: "alpha",
			confirmation: { kind: "plan-feature", subject: "lookup-tables" },
		},
	]);
	/* With the confirmation withdrawn, the check lists the feature again. */
	await page.route("**/publishing/compatibility?*", (route) =>
		route.fulfill({
			json: {
				ok: true,
				report: report("alpha"),
				confirmations: {
					plan_features: [
						{
							...lookupTables,
							id: "lookup-tables",
							state: "needs_confirmation",
						},
					],
					flat_location_fixture: null,
					connect_forwarder: null,
				},
			},
		}),
	);
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page.getByRole("button", { name: "Open publish", exact: true }).click();
	await expect(
		page.getByRole("checkbox", {
			name: "This project space has it Lookup Tables",
		}),
	).not.toBeChecked();
	await expect(upload).toBeDisabled();
});

test("native publish below the CommCare version floor links to the app whose settings raise it", async ({
	page,
}) => {
	const message =
		"The app on “alpha” is set to CommCare 2.53.0, and Nova's apps need 2.57 or later. You can raise the CommCare version in that app's settings in CommCare HQ, then publish again. Phones on an older CommCare can no longer install or update the app after that. Saving that page can also set the app's other settings there, so Nova may show you what changed before it publishes.";
	await page.route("**/api/commcare/upload", (route) =>
		route.fulfill({
			json: {
				success: false,
				refusal: {
					phase: "preflight",
					failure: {
						code: "hq_app_version_below_floor",
						message,
						details: [],
					},
					resourceConflicts: [],
					remoteChanges: [],
					confirmationsNeeded: [],
				},
				url: "https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
				preview_project_space: null,
			} satisfies PublishResponseBody,
		}),
	);
	await open(page);
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await expect(page.getByText(message, { exact: true })).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Open the app in CommCare HQ" }),
	).toHaveAttribute(
		"href",
		"https://www.commcarehq.org/a/alpha/apps/view/hq-app/",
	);
});
