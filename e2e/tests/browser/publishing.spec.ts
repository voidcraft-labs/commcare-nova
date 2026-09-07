import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { PublishResponseBody } from "@/components/builder/publishOutcome";
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
	await page.route("**/publishing/download/json?*", (route) => {
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
			.getByRole("button", { name: "Download JSON", exact: true })
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
		await old?.fulfill({ json: { ok: true } });
		await expect(
			page.getByRole("button", { name: "Download JSON", exact: true }),
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
		page.getByRole("button", { name: "Download JSON", exact: true }),
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
