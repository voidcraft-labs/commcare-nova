// @vitest-environment happy-dom

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import {
	type SearchableChoice,
	SearchableChoiceCombobox,
} from "../SearchableChoiceCombobox";

type ChoiceValue = "alpha" | "beta" | "gamma" | "more" | "delta";

const CHOICES: readonly SearchableChoice<ChoiceValue>[] = [
	{
		id: "alpha",
		label: "Alpha record",
		detail: "Used at intake",
		group: "Common information",
		value: "alpha",
	},
	{
		id: "beta",
		label: "Beta record",
		detail: "Used for follow-up",
		group: "Common information",
		searchText: "historic alias",
		value: "beta",
	},
	{
		id: "gamma",
		label: "Gamma record",
		group: "More information",
		value: "gamma",
	},
];

interface RenderChooserOptions {
	readonly choices?: readonly SearchableChoice<ChoiceValue>[];
	readonly onChoose?: (choice: SearchableChoice<ChoiceValue>) => void;
	readonly onClosed?: () => void;
	readonly emptyTitle?: string;
	readonly emptyDescription?: string;
}

function renderChooser({
	choices = CHOICES,
	onChoose = () => {},
	onClosed,
	emptyTitle,
	emptyDescription,
}: RenderChooserOptions = {}) {
	return render(
		<SearchableChoiceCombobox
			choices={choices}
			onChoose={onChoose}
			trigger={<button type="button" />}
			triggerLabel="Choose information"
			triggerContent={<span>Choose information</span>}
			heading="Choose case information"
			description="Pick the information this field should use"
			searchLabel="Search available information"
			searchPlaceholder="Search information"
			emptyTitle={emptyTitle}
			emptyDescription={emptyDescription}
			onClosed={onClosed}
		/>,
	);
}

async function openChooser(): Promise<{
	readonly trigger: HTMLElement;
	readonly input: HTMLInputElement;
}> {
	const trigger = screen.getByRole("combobox", {
		name: "Choose information",
	});
	fireEvent.click(trigger);
	const input = (await screen.findByRole("combobox", {
		name: "Search available information",
	})) as HTMLInputElement;
	await waitFor(() => expect(document.activeElement).toBe(input));
	return { trigger, input };
}

async function closeWithEscape(
	input: HTMLInputElement,
	trigger: HTMLElement,
): Promise<void> {
	fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
	await waitFor(() => {
		expect(
			screen.queryByRole("dialog", { name: "Choose case information" }),
		).toBeNull();
	});
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	await settleBaseUiTransitions();
}

describe("SearchableChoiceCombobox", () => {
	it("exposes one labeled trigger and a focused search combobox inside a labeled dialog", async () => {
		renderChooser();
		const trigger = screen.getByRole("combobox", {
			name: "Choose information",
		});
		expect(trigger.getAttribute("aria-expanded")).toBe("false");

		const opened = await openChooser();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(
			screen.getByRole("dialog", { name: "Choose case information" }),
		).toBeDefined();
		expect(
			screen.getByText("Pick the information this field should use"),
		).toBeDefined();
		expect(opened.input.placeholder).toBe("Search information");
		expect(opened.input.autocomplete).toBe("off");
		expect(opened.input.hasAttribute("data-1p-ignore")).toBe(true);
		expect(screen.getByRole("listbox")).toBeDefined();
		const emptyStatus = screen.getByRole("status");
		expect(emptyStatus.textContent).toBe("");
		expect(emptyStatus.classList.contains("empty:min-h-0")).toBe(true);

		await closeWithEscape(opened.input, opened.trigger);
	});

	it("filters from labels, details, and additional search terms while typing", async () => {
		renderChooser();
		const opened = await openChooser();

		fireEvent.change(opened.input, { target: { value: "follow-up" } });
		expect(opened.input.value).toBe("follow-up");
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(
			screen.getByRole("option", { name: /Beta record.*follow-up/i }),
		).toBeDefined();

		fireEvent.change(opened.input, { target: { value: "historic alias" } });
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(screen.getByRole("option", { name: /Beta record/i })).toBeDefined();

		await closeWithEscape(opened.input, opened.trigger);
	});

	it("uses ArrowDown and Enter to choose the first visible option", async () => {
		const onChoose = vi.fn();
		renderChooser({ onChoose });
		const opened = await openChooser();

		fireEvent.keyDown(opened.input, { key: "ArrowDown", code: "ArrowDown" });
		fireEvent.keyDown(opened.input, { key: "Enter", code: "Enter" });

		expect(onChoose).toHaveBeenCalledOnce();
		expect(onChoose.mock.calls[0]?.[0]).toMatchObject({
			id: "alpha",
			value: "alpha",
		});
		await waitFor(() => {
			expect(
				screen.queryByRole("dialog", { name: "Choose case information" }),
			).toBeNull();
		});
		await waitFor(() => expect(document.activeElement).toBe(opened.trigger));
		await settleBaseUiTransitions();
	});

	it("closes with Escape, restores trigger focus, and reports one close", async () => {
		const onClosed = vi.fn();
		renderChooser({ onClosed });
		const opened = await openChooser();

		await closeWithEscape(opened.input, opened.trigger);
		expect(onClosed).toHaveBeenCalledOnce();
		expect(opened.trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it("clears the search without moving focus away from its input", async () => {
		renderChooser();
		const opened = await openChooser();
		fireEvent.change(opened.input, { target: { value: "gamma" } });
		expect(screen.getAllByRole("option")).toHaveLength(1);

		const clearSearch = screen.getByRole("button", { name: "Clear search" });
		expect(clearSearch.getAttribute("data-size")).toBe("icon-lg");
		fireEvent.click(clearSearch);
		expect(opened.input.value).toBe("");
		expect(document.activeElement).toBe(opened.input);
		expect(screen.getAllByRole("option")).toHaveLength(3);

		await closeWithEscape(opened.input, opened.trigger);
	});

	it("keeps options in their labeled groups", async () => {
		renderChooser();
		const opened = await openChooser();
		const common = screen.getByRole("group", { name: "Common information" });
		const more = screen.getByRole("group", { name: "More information" });

		expect(within(common).getAllByRole("option")).toHaveLength(2);
		expect(
			within(common).getByRole("option", { name: /Alpha record/i }),
		).toBeDefined();
		expect(within(more).getAllByRole("option")).toHaveLength(1);
		expect(
			within(more).getByRole("option", { name: /Gamma record/i }),
		).toBeDefined();

		await closeWithEscape(opened.input, opened.trigger);
	});

	it("shows the supplied empty-state recovery copy when nothing matches", async () => {
		renderChooser({
			emptyTitle: "No available fields match",
			emptyDescription: "Try another name",
		});
		const opened = await openChooser();
		fireEvent.change(opened.input, { target: { value: "not present" } });

		const status = screen.getByRole("status");
		expect(status.textContent).toContain("No available fields match");
		expect(status.textContent).toContain("Try another name");
		expect(screen.queryByRole("option")).toBeNull();

		await closeWithEscape(opened.input, opened.trigger);
	});

	it("scrolls choices and empty recovery together beneath fixed popup controls", async () => {
		renderChooser({
			emptyTitle: "No available fields match",
			emptyDescription: "Try another name",
		});
		const opened = await openChooser();
		const dialog = screen.getByRole("dialog", {
			name: "Choose case information",
		});
		const scrollRegion = dialog.querySelector("[data-combobox-scroll-region]");
		const listbox = screen.getByRole("listbox");

		expect(scrollRegion).not.toBeNull();
		expect(scrollRegion?.classList.contains("min-h-0")).toBe(true);
		expect(scrollRegion?.classList.contains("flex-1")).toBe(true);
		expect(scrollRegion?.classList.contains("overflow-y-auto")).toBe(true);
		expect(scrollRegion?.contains(listbox)).toBe(true);
		expect(scrollRegion?.contains(opened.input)).toBe(false);
		expect(listbox.classList.contains("flex-none")).toBe(true);
		expect(listbox.classList.contains("overflow-visible")).toBe(true);

		fireEvent.change(opened.input, { target: { value: "not present" } });
		expect(scrollRegion?.contains(screen.getByRole("status"))).toBe(true);

		await closeWithEscape(opened.input, opened.trigger);
	});

	it("keeps a progressive choice open while its next choices replace the list", async () => {
		const onClosed = vi.fn();
		const onChoose = vi.fn();
		const progressive: SearchableChoice<ChoiceValue> = {
			id: "more",
			label: "Show more information",
			detail: "Choose from information already used",
			group: "More choices",
			value: "more",
			keepOpen: true,
		};
		const finalChoice: SearchableChoice<ChoiceValue> = {
			id: "delta",
			label: "Delta record",
			group: "More information",
			value: "delta",
		};

		function ProgressiveHarness() {
			const [advanced, setAdvanced] = useState(false);
			return (
				<SearchableChoiceCombobox
					choices={advanced ? [finalChoice] : [progressive]}
					onChoose={(choice) => {
						onChoose(choice);
						if (choice.keepOpen) setAdvanced(true);
					}}
					trigger={<button type="button" />}
					triggerLabel="Choose information"
					triggerContent={<span>Choose information</span>}
					heading="Choose case information"
					searchLabel="Search available information"
					searchPlaceholder="Search information"
					onClosed={onClosed}
				/>
			);
		}

		render(<ProgressiveHarness />);
		const opened = await openChooser();
		fireEvent.click(
			screen.getByRole("option", { name: /Show more information/i }),
		);

		expect(onChoose).toHaveBeenCalledOnce();
		expect(onChoose.mock.calls[0]?.[0]).toMatchObject({ id: "more" });
		expect(onClosed).not.toHaveBeenCalled();
		expect(
			await screen.findByRole("option", { name: "Delta record" }),
		).toBeDefined();
		expect(
			screen.getByRole("dialog", { name: "Choose case information" }),
		).toBeDefined();

		await closeWithEscape(opened.input, opened.trigger);
		expect(onClosed).toHaveBeenCalledOnce();
	});
});
