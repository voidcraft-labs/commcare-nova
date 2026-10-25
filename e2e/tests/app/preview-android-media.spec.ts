import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { PREVIEW_ANDROID_MEDIA_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * An app that runs only on Android, whose question's label carries an AMR
 * recording. Preview plays media in the browser, which plays what Web Apps
 * plays, so where only Android plays a file it shows a line in the player's
 * place. The line comes from the asset's real row, read through the library
 * route Preview resolves rows with, with no route mocked; and Preview asks for
 * no bytes of a file it will not play.
 */
test("Preview shows a line in place of audio only Android plays", {
	tag: "@seed:preview-android-media",
}, async ({ scenario, page }) => {
	const { previewAndroidMedia } = seedFor(scenario, "preview-android-media");
	const bytesRequests: string[] = [];
	page.on("request", (request) => {
		if (
			new URL(request.url()).pathname ===
			`/api/media/${previewAndroidMedia.assetId}`
		)
			bytesRequests.push(request.url());
	});
	await openBuilder(page, previewAndroidMedia.route);
	const preview = page.getByRole("button", { name: "Preview", exact: true });
	await expect(preview).toBeVisible({ timeout: 20_000 });
	await preview.click();
	const main = page.locator("main");
	await expect(
		main.getByText(PREVIEW_ANDROID_MEDIA_SEED.questionLabel),
	).toBeVisible({ timeout: 20_000 });
	await expect(
		main.getByText(PREVIEW_ANDROID_MEDIA_SEED.standIn),
	).toBeVisible();
	await expect(main.locator("audio")).toHaveCount(0);
	expect(bytesRequests).toEqual([]);
});
