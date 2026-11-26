import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { ANDROID_DEEP_LINK_VISIT_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * On Android a visit a deep link opened ends with its first form. Submitted
 * or left, CommCare resets the session and returns to the app that opened
 * the link before any after-submit runs
 * (`SessionLaunchDelegate.kt::exitFromExternalLaunch`, witnessed by
 * `proof/android/test_navigation.py`), so Preview running as Android shows
 * the phone's home screen. The visit form's after-submit is Previous, which
 * would otherwise land on the patient list.
 */
test("on Android a deep link's form ends the visit on the phone's home screen, submitted or left", {
	tag: "@seed:android-deep-link-visit",
}, async ({ scenario, page }) => {
	const { androidDeepLinkVisit } = seedFor(scenario, "android-deep-link-visit");
	const seed = ANDROID_DEEP_LINK_VISIT_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
	const start = main.getByRole("button", { name: "Start", exact: true });
	const note = main.getByRole("textbox", { name: seed.noteLabel });

	const launch = async () => {
		await openBuilder(
			page,
			`${androidDeepLinkVisit.route}/${seed.entryPoint.uuid}`,
		);
		await expect(page.getByLabel("Link ID", { exact: true })).toHaveValue(
			seed.entryPoint.id,
			{ timeout: 20_000 },
		);
		await page
			.getByRole("combobox", { name: `${seed.moduleName} cases`, exact: true })
			.click();
		await page
			.getByRole("option", { name: seed.patient.caseName, exact: true })
			.click();
		const open = page.getByRole("button", {
			name: "Test in Preview",
			exact: true,
		});
		await expect(open).toBeEnabled();
		await open.click();
		await expect(page).toHaveURL(
			new RegExp(`/build/${androidDeepLinkVisit.appId}/${seed.formUuid}`),
			{ timeout: 20_000 },
		);
		await expect(note).toBeVisible({ timeout: 20_000 });
	};

	await test.step("Back from the form the link opened shows the phone's home screen", async () => {
		await launch();
		await page
			.getByRole("navigation", { name: "Page navigation" })
			.getByRole("button", { name: "Go back", exact: true })
			.click();
		await expect(start).toBeVisible({ timeout: 20_000 });
		await expect(page).toHaveURL(
			new RegExp(`/build/${androidDeepLinkVisit.appId}$`),
		);
		await expect(note).toHaveCount(0);
	});

	await test.step("submitting it shows the phone's home screen, not the patient list Previous names", async () => {
		await launch();
		await note.fill("Seen at home");
		const finish = main.getByRole("button", { name: "Finish", exact: true });
		await expect(finish).toBeEnabled({ timeout: 20_000 });
		await finish.click();
		await expect(start).toBeVisible({ timeout: 20_000 });
		await expect(page).toHaveURL(
			new RegExp(`/build/${androidDeepLinkVisit.appId}$`),
		);
		await expect(
			main.getByRole("button", {
				name: new RegExp(`^View details for ${seed.patient.caseName}`),
			}),
		).toHaveCount(0);
	});
});
