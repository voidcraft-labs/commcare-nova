import { expect, seedFor, test } from "../../lib/appFixtures";
import { CASE_CHANGES_SEED } from "../../lib/caseChangesSeed";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";

// Its own admitted application and real Project rows are allocated by native
// Playwright discovery. The peer tab edits through the actual Builder mutation and multiplayer flow.
test(
	"Preview pauses when another Builder tab removes the selected persona and resumes only after explicit recovery",
	{ tag: "@seed:case-changes" },
	async ({ scenario, page, context, baseURL }, _testInfo) => {
		const seed = seedFor(scenario, "case-changes");

		test.setTimeout(120_000);
		const { appId } = seed.caseChanges;
		const peer = await context.newPage();
		const guard = await attachErrorGuard(peer, baseURL);
		try {
			await peer.goto(`/build/${appId}/setup/users`);
			const personas = peer.getByRole("region", { name: "Personas" });
			// The actual write control waits for admission. Streamed hidden
			// boundaries may briefly contain a second catalog diagnostic marker.
			const addPersona = personas.getByRole("button", {
				name: "Add persona",
				exact: true,
			});
			await expect(addPersona).toBeEnabled();
			await addPersona.click();
			const name = personas.getByLabel("Name", { exact: true });
			await expect(name).toBeFocused();
			await name.fill("Shell recovery worker");
			const saved = peer.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === `/api/apps/${appId}` &&
					response.request().method() === "PUT" &&
					(response.request().postData() ?? "").includes(
						'"kind":"updatePersona"',
					),
			);
			await name.press("Enter");
			expect((await saved).ok()).toBe(true);
			await page.goto(`/build/${appId}`);
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			const running = page.getByRole("button", { name: /^Running as/ });
			await running.click();
			await page
				.getByRole("menuitemradio", {
					name: "Preview as Shell recovery worker",
					exact: true,
				})
				.click();
			const patients = page.locator("main").getByRole("button", {
				name: new RegExp(`^${CASE_CHANGES_SEED.moduleName}\\b`),
			});
			await expect(patients).toBeVisible();
			await expect(running).toHaveAccessibleName(
				/Running as Shell recovery worker/,
			);
			await personas
				.getByRole("button", { name: "Remove persona", exact: true })
				.click();
			const remove = personas.getByRole("button", {
				name: "Remove",
				exact: true,
			});
			await expect(remove).toBeEnabled();
			await remove.click();
			const paused = page.getByRole("alert").filter({
				hasText: "The persona you selected is no longer in this app",
			});
			await expect(paused).toBeVisible();
			await expect(patients).toBeHidden();
			await expect(
				page
					.locator("main")
					.getByRole("heading", { name: "Choose who is previewing" }),
			).toBeVisible();
			await expect(running).toHaveAccessibleName(
				/Selected persona unavailable/,
			);
			await paused
				.getByRole("button", { name: "Preview as me", exact: true })
				.click();
			await expect(paused).toHaveCount(0);
			await expect(patients).toBeVisible();
			await expect(running).toHaveAccessibleName(/Running as Preview as me/);
			await expect(
				page.locator("main[data-preview-scroll-container]"),
			).toHaveCount(1);
		} finally {
			try {
				await closePageWithUnload(peer);
			} finally {
				await guard.assertNoErrors();
			}
		}
	},
);

test(
	"Browser Back retires the parent selector before opening that parent's own case workflow",
	{ tag: "@seed:case-changes" },
	async ({ scenario, page }, _testInfo) => {
		const seed = seedFor(scenario, "case-changes");

		const { appId } = seed.caseChanges;
		await page.goto(`/build/${appId}`);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const main = page.locator("main");
		const patients = main.getByRole("button", {
			name: new RegExp(`^${CASE_CHANGES_SEED.moduleName}\\b`),
		});
		await expect(patients).toBeVisible();
		await main
			.getByRole("button", {
				name: new RegExp(`^${CASE_CHANGES_SEED.archivedModuleName}\\b`),
			})
			.click();
		await expect(
			main.getByRole("heading", {
				name: CASE_CHANGES_SEED.moduleName,
				exact: true,
			}),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: /^View details for Smoke patient/ }),
		).toBeVisible();
		await page.goBack();
		await expect(patients).toBeVisible();
		await patients.click();
		await main
			.getByRole("button", { name: /^View details for Smoke patient/ })
			.click();
		await expect(
			main.getByRole("heading", { name: "Smoke patient", exact: true }),
		).toBeVisible();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			main.getByRole("heading", {
				name: "Smoke patient",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			main.getByRole("button", {
				name: CASE_CHANGES_SEED.formName,
				exact: true,
			}),
		).toBeVisible();
	},
);
