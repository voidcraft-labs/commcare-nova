/**
 * Real-browser audit of the deployment surface in the Publish dialog.
 *
 * It drives the actual dialog against the running app, and intercepts
 * `/api/commcare/upload` so the success screen renders WITHOUT contacting
 * CommCare HQ — no real import, no real project space touched. Everything
 * below the interception is genuine: real component, real tokens, real
 * layout, real keyboard behavior.
 */

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const OUT = process.env.AUDIT_OUT ?? "/tmp/nova-deploy-audit";
mkdirSync(OUT, { recursive: true });

const WIDTHS = [
	{ name: "compact", width: 390, height: 844 },
	{ name: "medium", width: 760, height: 900 },
	{ name: "expanded", width: 1280, height: 900 },
	{ name: "large", width: 1600, height: 1000 },
];

function uploadBody({ state, resumePhase, phases, superseded = [], sections }) {
	return {
		success: state !== "incomplete",
		url: "https://www.commcarehq.org/a/rhi-bihar/apps/view/hq-abc/",
		warnings: [],
		feature_flag_requirements: null,
		preflight: [],
		deployment: {
			deployment: {
				id: "dep-1",
				appId: "app-1",
				projectId: "proj-1",
				server: "production",
				domain: "rhi-bihar",
				state,
				resumePhase,
				phases,
				createdBy: "u1",
				createdAt: "2026-08-06T00:00:00.000Z",
				updatedAt: "2026-08-06T00:00:00.000Z",
				lastObservedAt: null,
			},
			active: [
				{
					deploymentId: "dep-1",
					kind: "app",
					novaResourceId: "app-1",
					remoteId: "hq-abc",
					ownership: "nova-created",
					adoptedAt: null,
					adoptedBy: null,
					pushedRevision: 12,
					pushedAt: null,
					remoteRevision: 1,
					remoteObservedAt: null,
					supersededAt: null,
				},
			],
			superseded,
		},
		setup_artifact: {
			server: "production",
			domain: "rhi-bihar",
			hqAppId: "hq-abc",
			sections,
		},
	};
}

const NONE = {
	preflight: null,
	upload: null,
	build: null,
	release: null,
	probe: null,
};
const OK = (at = "2026-08-06T00:00:00.000Z") => ({ status: "succeeded", at });

const SECTIONS = [
	{
		id: "worker-data",
		title: "Worker information",
		summary:
			"The information your workers carry. Create one field per row on “rhi-bihar”.",
		url: "https://www.commcarehq.org/a/rhi-bihar/settings/users/user_data/",
		steps: [
			"Add a field with property name “block” and label “Block”. Tick Required, and under “Required for” choose Mobile Workers.",
		],
		caveats: [
			"CommCare HQ has no API for this page, so Nova cannot create these fields for you and cannot tell whether they already exist.",
		],
	},
	{
		id: "build-and-release",
		title: "Make a version and release it",
		summary:
			"Nova puts the app on your project space. Turning it into something workers can open is two clicks there, and only a signed-in person can make them.",
		url: "https://www.commcarehq.org/a/rhi-bihar/apps/view/hq-abc/releases/",
		steps: [
			"Open the app's Releases screen on CommCare HQ.",
			"Choose Make new version, and wait for it to finish.",
			"Star the new version to release it.",
		],
		caveats: [
			"CommCare HQ only lets a signed-in person do this. Its build and release pages accept a browser session and not an API key, so Nova watches for it rather than doing it.",
		],
	},
];

const SCENARIOS = {
	uploaded: uploadBody({
		state: "uploaded",
		resumePhase: null,
		phases: { ...NONE, preflight: OK(), upload: OK() },
		sections: SECTIONS,
	}),
	"uploaded-pending-build": uploadBody({
		state: "uploaded",
		resumePhase: null,
		phases: {
			...NONE,
			preflight: OK(),
			upload: OK(),
			build: {
				status: "pending",
				at: "2026-08-06T00:00:00.000Z",
				reason:
					"CommCare HQ hasn't built this app yet. Open it there and choose Make new version.",
			},
		},
		sections: SECTIONS,
	}),
	runnable: uploadBody({
		state: "runnable",
		resumePhase: null,
		phases: {
			preflight: OK(),
			upload: OK(),
			build: OK(),
			release: OK(),
			probe: OK(),
		},
		sections: SECTIONS,
	}),
	incomplete: uploadBody({
		state: "incomplete",
		resumePhase: "probe",
		phases: {
			preflight: OK(),
			upload: OK(),
			build: OK(),
			release: OK(),
			probe: {
				status: "failed",
				at: "2026-08-06T00:00:00.000Z",
				failure: {
					code: "build_not_installable",
					message:
						"The released build didn't serve the file a device installs from, so Nova can't confirm workers can open it yet. Try releasing it again on CommCare HQ, then check back.",
					details: [],
				},
			},
		},
		sections: SECTIONS,
	}),
	superseded: uploadBody({
		state: "uploaded",
		resumePhase: null,
		phases: { ...NONE, preflight: OK(), upload: OK() },
		superseded: [
			{
				deploymentId: "dep-1",
				kind: "app",
				novaResourceId: "app-1",
				remoteId: "hq-old-1",
				ownership: "nova-created",
				adoptedAt: null,
				adoptedBy: null,
				pushedRevision: 8,
				pushedAt: null,
				remoteRevision: null,
				remoteObservedAt: null,
				supersededAt: "2026-08-05T00:00:00.000Z",
			},
		],
		sections: SECTIONS,
	}),
};

const problems = [];
function note(scenario, size, message) {
	problems.push(`[${scenario} @ ${size}] ${message}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

page.on("console", (msg) => {
	if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
});
page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));

// Sign in, then land on an app.
await page.goto("http://localhost:3000/api/dev/login", { waitUntil: "load" });
await page.goto("http://localhost:3000/", { waitUntil: "load" });

// Find any existing app; otherwise create the canonical starter.
await page.waitForTimeout(2500);
const hrefs = await page
	.locator('a[href^="/build/"]')
	.evaluateAll((as) =>
		as
			.map((a) => a.getAttribute("href"))
			.filter((h) => h && h !== "/build/new"),
	);
let appHref = hrefs[0] ?? null;
console.log("auditing", appHref);
if (!appHref) {
	const blank = page.getByRole("button", { name: /blank app/i }).first();
	if (await blank.isVisible().catch(() => false)) {
		await blank.click();
		await page.waitForURL(/\/build\/(?!new)/, { timeout: 120_000 });
		appHref = new URL(page.url()).pathname;
	}
}
if (!appHref) {
	console.error("Could not reach an app to audit.");
	await browser.close();
	process.exit(1);
}

await page.route("**/api/commcare/upload", async (route) => {
	const scenario = await page.evaluate(() => window.__novaAuditScenario);
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(SCENARIOS[scenario] ?? SCENARIOS.uploaded),
	});
});
await page.route("**/api/commcare/feature-flags", (route) =>
	route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({
			feature_flag_requirements: {
				verification: "not_required",
				required_flags: [],
				missing_flags: [],
				unverified_flags: [],
				support_email: "support@dimagi.com",
				docs_url: "https://docs.commcare.app/feature-flags",
				message: "",
			},
		}),
	}),
);

for (const scenario of ["incomplete", "superseded"]) {
	for (const size of WIDTHS) {
		console.log(`  ${scenario} @ ${size.name}`);
		await page.setViewportSize({ width: size.width, height: size.height });
		await page.goto(`http://localhost:3000${appHref}`, { waitUntil: "load" });
		await page.evaluate((name) => {
			window.__novaAuditScenario = name;
		}, scenario);

		await page.waitForTimeout(3500);
		const publish = page.getByRole("button", { name: /^publish$/i }).first();
		if (!(await publish.isVisible().catch(() => false))) {
			note(scenario, size.name, "Publish button not reachable");
			continue;
		}
		await publish.click();

		const dialog = page.getByRole("dialog");
		await dialog.waitFor({ timeout: 15_000 }).catch(() => {});

		// Fill the form and publish.
		const upload = dialog
			.getByRole("button", { name: /upload|publish to commcare/i })
			.last();
		if (await upload.isEnabled().catch(() => false)) {
			await upload.click();
		} else {
			note(scenario, size.name, "Upload action never became enabled");
		}

		await page
			.getByRole("heading", { name: /rhi-bihar/i })
			.waitFor({ timeout: 15_000 })
			.catch(() =>
				note(scenario, size.name, "Deployment status never rendered"),
			);
		// Let the success transition finish before measuring or capturing.
		await page.waitForTimeout(1200);

		// No horizontal page scroll at any width.
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		if (overflow > 1) {
			note(scenario, size.name, `page scrolls horizontally by ${overflow}px`);
		}

		// Every interactive control clears the pointer-target floor.
		const small = await dialog.evaluate((root) => {
			const out = [];
			for (const el of root.querySelectorAll(
				'button, a[href], [role="button"]',
			)) {
				const r = el.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) continue;
				if (r.height < 44 - 0.5) {
					out.push(
						`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" is ${Math.round(r.height)}px tall`,
					);
				}
			}
			return out;
		});
		for (const s of small) note(scenario, size.name, `touch target: ${s}`);

		await page.screenshot({
			path: `${OUT}/${scenario}-${size.name}.png`,
			fullPage: true,
		});
	}
}

// Keyboard + focus, at one width.
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`http://localhost:3000${appHref}`, { waitUntil: "load" });
await page.evaluate(() => {
	window.__novaAuditScenario = "incomplete";
});
await page.waitForTimeout(3500);
await page
	.getByRole("button", { name: /^publish$/i })
	.first()
	.click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ timeout: 30_000 }).catch(() => {});
const upload = dialog
	.getByRole("button", { name: /upload|publish to commcare/i })
	.last();
if (await upload.isEnabled().catch(() => false)) await upload.click();
await page
	.getByRole("heading", { name: /rhi-bihar/i })
	.waitFor({ timeout: 15_000 })
	.catch(() => {});
await page.waitForTimeout(1200);

// A setup note must open from the keyboard and announce its state.
const note0 = dialog.getByRole("button", { name: /Make a version/i }).first();
if (await note0.isVisible().catch(() => false)) {
	await note0.focus();
	const expandedBefore = await note0.getAttribute("aria-expanded");
	await page.keyboard.press("Enter");
	const expandedAfter = await note0.getAttribute("aria-expanded");
	if (expandedBefore !== "false" || expandedAfter !== "true") {
		problems.push(
			`setup note aria-expanded did not toggle false→true (got ${expandedBefore}→${expandedAfter})`,
		);
	}
	const ring = await note0.evaluate((el) => {
		const s = getComputedStyle(el);
		return { outline: s.outlineWidth, shadow: s.boxShadow };
	});
	if (ring.outline === "0px" && ring.shadow === "none") {
		problems.push("focused setup note shows no visible focus treatment");
	}
} else {
	problems.push("setup notes not reachable");
}

// The refusal must be announced, not merely coloured.
const alerts = await dialog.getByRole("alert").allTextContents();
if (!alerts.some((t) => /didn't serve the file/i.test(t))) {
	problems.push("incomplete failure is not exposed through role=alert");
}
const resumeCopy = await dialog.textContent();
if (!/carry on from released/i.test(resumeCopy ?? "")) {
	problems.push("refusal does not name the state a retry resumes from");
}

await page.screenshot({ path: `${OUT}/keyboard-focus.png`, fullPage: true });
await browser.close();

console.log(`screenshots → ${OUT}`);
if (problems.length === 0) {
	console.log("AUDIT CLEAN");
} else {
	console.log(`AUDIT FINDINGS (${problems.length}):`);
	for (const p of problems) console.log(` - ${p}`);
}
