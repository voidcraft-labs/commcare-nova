import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The builder's breadcrumb trail, pressed and asserted whatever shape it is
 * in.
 *
 * `CollapsibleBreadcrumb` (`components/builder/SubheaderToolbar.tsx`) shows
 * every ancestor as an inline button while the whole trail fits its bar, and
 * folds them all behind one path menu (a Popover whose trigger is named
 * "Show breadcrumb path", portaled to `document.body`) once it does not. Which
 * shape a trail takes depends on the fonts and the viewport: a trail that fits
 * by a few pixels on one machine folds on another. A spec that reaches for an
 * ancestor as an inline button therefore passes on one machine and waits out
 * its timeout on the next, so every press or assertion of an ancestor crumb
 * goes through here.
 *
 * The fold is decided after layout. The component compares the natural width
 * of an inert, aria-hidden mirror of the whole trail with the width its bar
 * gives it: on a change of labels in the same commit, on a change of the
 * bar's width in a ResizeObserver callback whose state update renders a frame
 * or more later. So the shape on screen can lag the measurement after a
 * resize. These helpers read the same two widths the component reads and act
 * only once the shape on screen is the one they call for; at that point the
 * component has nothing left to change until the bar or the labels change
 * again.
 */

const PAGE_NAVIGATION = "Page navigation";
const PATH_MENU = "Show breadcrumb path";
/** The suite's usual wait for something the app is about to show. */
const SETTLE_TIMEOUT = 20_000;

type TrailReading =
	| { readonly kind: "missing"; readonly count: number }
	| {
			readonly kind: "trail";
			/** Whether the ancestors are inline buttons or in the path menu. */
			readonly shape: "inline" | "menu";
			/** Whether the shape is the one the trail's widths call for. */
			readonly settled: boolean;
			/** Every crumb's label, the current location last. `null` on the
			 * handset case workspace, which draws only the path menu. */
			readonly labels: readonly string[] | null;
			readonly avail: number;
			readonly natural: number;
	  };

function readTrail(navs: Element[], pathLabel: string): TrailReading {
	if (navs.length !== 1) return { kind: "missing", count: navs.length };
	const trail = navs[0].querySelector("[data-breadcrumb-trail]");
	if (trail === null) return { kind: "missing", count: 0 };
	const hasMenu = Array.from(trail.querySelectorAll("button")).some(
		(button) => button.getAttribute("aria-label") === pathLabel,
	);
	if (trail.hasAttribute("data-compact-workspace-breadcrumb")) {
		return {
			kind: "trail",
			shape: "menu",
			settled: true,
			labels: null,
			avail: 0,
			natural: 0,
		};
	}
	const wrapper = trail.parentElement;
	const mirror = wrapper?.querySelector(':scope > [aria-hidden="true"] > div');
	if (!wrapper || !mirror) return { kind: "missing", count: 0 };
	const labels = Array.from(mirror.children)
		.filter((child) => child.tagName === "SPAN")
		.map((child) => child.textContent ?? "");
	const avail = wrapper.clientWidth;
	const natural = mirror.scrollWidth;
	// The component's own rule: fold only once laid out, past a 1px tolerance.
	const folds =
		labels.length > 1 && natural > 0 && avail > 0 && natural > avail + 1;
	return {
		kind: "trail",
		shape: hasMenu ? "menu" : "inline",
		settled: folds === hasMenu,
		labels,
		avail,
		natural,
	};
}

/** "ready" when `label` can be pressed now, else what stands in the way. */
function describeReading(reading: TrailReading, label: string): string {
	if (reading.kind === "missing") {
		return reading.count > 1
			? `the page holds ${reading.count} "${PAGE_NAVIGATION}" landmarks`
			: "the page shows no breadcrumb trail";
	}
	if (!reading.settled) {
		return `the trail is still settling: it shows its ancestors ${
			reading.shape === "menu" ? "in the path menu" : "inline"
		} while its ${reading.natural}px fit ${reading.avail}px of bar`;
	}
	if (reading.labels === null) return "ready";
	const shown = `${reading.labels.join(" > ")} (ancestors ${
		reading.shape === "menu" ? "in the path menu" : "inline"
	})`;
	if (reading.labels.at(-1) === label) {
		return `"${label}" is the current location, which the trail names but does not offer; the trail reads ${shown}`;
	}
	if (!reading.labels.slice(0, -1).includes(label)) {
		return `"${label}" is not an ancestor crumb; the trail reads ${shown}`;
	}
	return "ready";
}

/** Waits until the trail has settled its shape and offers `label`. */
async function settledTrail(
	page: Page,
	label: string,
): Promise<Extract<TrailReading, { kind: "trail" }>> {
	const navigation = page.getByRole("navigation", { name: PAGE_NAVIGATION });
	const latest: { reading: TrailReading } = {
		reading: { kind: "missing", count: 0 },
	};
	await expect
		.poll(
			async () => {
				latest.reading = await navigation.evaluateAll(readTrail, PATH_MENU);
				return describeReading(latest.reading, label);
			},
			{
				message: `The breadcrumb trail never offered "${label}" as a crumb to press`,
				timeout: SETTLE_TIMEOUT,
			},
		)
		.toBe("ready");
	const { reading } = latest;
	if (reading.kind !== "trail") {
		throw new Error("The breadcrumb trail settled without being read");
	}
	return reading;
}

/** Opens the trail's path menu and returns its popup. */
async function openPathMenu(page: Page): Promise<{
	readonly trigger: Locator;
	readonly popup: Locator;
}> {
	const trigger = page
		.getByRole("navigation", { name: PAGE_NAVIGATION })
		.getByRole("button", { name: PATH_MENU, exact: true });
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	const popupId = await trigger.getAttribute("aria-controls");
	if (popupId === null) {
		throw new Error(
			"The breadcrumb path menu opened without naming its popup (aria-controls)",
		);
	}
	const popup = page.locator(`id=${popupId}`);
	await expect(popup).toBeVisible();
	return { trigger, popup };
}

/**
 * Presses the ancestor crumb named `label`: its inline button while the
 * trail fits, else its entry in the path menu.
 */
export async function pressTrailCrumb(
	page: Page,
	label: string,
): Promise<void> {
	const reading = await settledTrail(page, label);
	if (reading.shape === "inline") {
		await page
			.getByRole("navigation", { name: PAGE_NAVIGATION })
			.getByRole("button", { name: label, exact: true })
			.click();
		return;
	}
	const { popup } = await openPathMenu(page);
	await popup.getByRole("button", { name: label, exact: true }).click();
}

/**
 * Asserts the trail offers `label` as an ancestor crumb: a visible inline
 * button while the trail fits, else an entry of the path menu, which this
 * opens to look at and closes again.
 */
export async function expectTrailCrumbOffered(
	page: Page,
	label: string,
): Promise<void> {
	const reading = await settledTrail(page, label);
	if (reading.shape === "inline") {
		await expect(
			page
				.getByRole("navigation", { name: PAGE_NAVIGATION })
				.getByRole("button", { name: label, exact: true }),
		).toBeVisible();
		return;
	}
	const { trigger, popup } = await openPathMenu(page);
	await expect(
		popup.getByRole("button", { name: label, exact: true }),
	).toBeVisible();
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(popup).toBeHidden();
}
