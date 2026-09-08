import { expect, seedFor, test } from "../../lib/appFixtures";
import { CASE_WORKSPACE_SEED } from "../../lib/caseWorkspaceSeed";

type ExitObservation = {
	sawNativeAnimation: boolean;
	hiddenWhileAnimating: boolean;
};
type ObservedPanel = HTMLElement & { exitObservation: ExitObservation };

test.use({ reducedMotion: "no-preference" });

test("a retained row inspector finishes its exit and returns after desktop resize", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	await page.setViewportSize({ width: 500, height: 780 });
	await page.goto(seed.caseWorkspace.routes.projectData);
	await page
		.getByRole("button", {
			name: new RegExp(`^${CASE_WORKSPACE_SEED.lookupTableName}`),
		})
		.click();
	const openRow = page
		.getByRole("row", { name: /District hospital/ })
		.getByRole("button", { name: /^Open row/ });
	await openRow.click();
	const destination = page.getByRole("textbox", {
		name: new RegExp(`^${CASE_WORKSPACE_SEED.lookupLabelColumnLabel}`),
	});
	await destination.fill("  District hospital  ");
	const panel = page.locator("[data-builder-chat-panel]");
	await expect(panel).toBeInViewport({ ratio: 1 });
	const mountedPanel = await panel.elementHandle();

	// Base UI's hide lifecycle observes browser animations. Observe that same
	// public browser boundary while the real drawer closes; an x-only Motion
	// animation used to disappear from it and hide the panel mid-exit.
	await panel.evaluate((element) => {
		const node = element as ObservedPanel;
		const observation: ExitObservation = {
			sawNativeAnimation: false,
			hiddenWhileAnimating: false,
		};
		node.exitObservation = observation;
		let frame: number | undefined;
		let closing = false;
		const inspect = () => {
			const running = node
				.getAnimations()
				.filter(
					(animation) => animation.pending || animation.playState === "running",
				);
			if (node.hasAttribute("data-ending-style")) {
				closing = true;
				observation.sawNativeAnimation ||= running.length > 0;
			}
			if (node.hidden) {
				observation.hiddenWhileAnimating = running.length > 0;
				observer.disconnect();
				if (frame !== undefined) cancelAnimationFrame(frame);
				return;
			}
			if (closing && frame === undefined) {
				frame = requestAnimationFrame(() => {
					frame = undefined;
					inspect();
				});
			}
		};
		const observer = new MutationObserver(inspect);
		observer.observe(node, {
			attributes: true,
			attributeFilter: ["data-ending-style", "hidden"],
		});
	});
	await page.keyboard.press("Escape");
	await expect(panel).toHaveAttribute("hidden", "");
	await expect(openRow).toBeFocused();
	expect(
		await panel.evaluate((node) => (node as ObservedPanel).exitObservation),
	).toEqual({ sawNativeAnimation: true, hiddenWhileAnimating: false });

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.getByRole("button", { name: "Review row work" }).click();
	await expect(destination).toHaveValue("  District hospital  ");
	await expect(panel).toBeInViewport({ ratio: 1 });
	expect(await mountedPanel?.evaluate((node) => node.isConnected)).toBe(true);
	const save = page.getByRole("button", { name: "Save row" });
	await expect(save).toBeInViewport();
	await save.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Saved." }),
	).toBeVisible();
	await expect(destination).toHaveValue("  District hospital  ");
});
