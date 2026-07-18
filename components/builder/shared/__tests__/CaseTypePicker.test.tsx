// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CaseTypePicker,
	CaseTypePickerContent,
} from "@/components/builder/shared/CaseTypePicker";

const state = vi.hoisted(() => ({
	caseTypes: [{ name: "client_record" }, { name: "household" }],
}));

vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useCaseTypes: () => state.caseTypes,
}));

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
	state.caseTypes = [{ name: "client_record" }, { name: "household" }];
});

describe("CaseTypePicker", () => {
	it("gives an empty list a quiet two-line next step", () => {
		state.caseTypes = [];
		render(<CaseTypePickerContent onChange={vi.fn()} />);

		expect(screen.getByText("No case types yet")).toBeDefined();
		expect(screen.getByText("Create one below")).toBeDefined();
	});

	it("shows friendly names while preserving exact stored selections", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		const onChange = vi.fn();
		const onClear = vi.fn();
		render(
			<CaseTypePicker
				value="client_record"
				onChange={onChange}
				onClear={onClear}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "Case type: Client record",
		});
		expect(trigger.getAttribute("data-slot")).toBe("popover-trigger");
		expect(trigger.className).toContain("min-h-11");
		expect(trigger.className).toContain("text-sm");
		expect(screen.queryByText("client_record")).toBeNull();
		fireEvent.click(trigger);

		const selected = await screen.findByRole("button", {
			name: "Client record",
		});
		expect(selected.getAttribute("data-slot")).toBe("button");
		expect(selected.className).toContain("text-sm");
		expect(selected.className).not.toContain("font-mono");
		expect(
			screen.getByLabelText("Create case type").getAttribute("data-slot"),
		).toBe("input");
		const content = document.querySelector('[data-slot="popover-content"]');
		expect(content?.className).toContain("var(--available-height");

		fireEvent.click(screen.getByRole("button", { name: "Household" }));
		expect(onChange).toHaveBeenCalledWith("household");
		await waitFor(() =>
			expect(
				document.querySelector('[data-slot="popover-content"]'),
			).toBeNull(),
		);
	});

	it("creates a valid stored identifier from a natural phrase", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		const onChange = vi.fn();
		render(<CaseTypePicker onChange={onChange} />);

		fireEvent.click(
			screen.getByRole("button", { name: "Case type: Pick a case type" }),
		);
		const input = await screen.findByLabelText("Create case type");
		fireEvent.change(input, { target: { value: "Home follow-up visit" } });
		fireEvent.click(screen.getByRole("button", { name: "Create" }));

		expect(onChange).toHaveBeenCalledWith("home_follow_up_visit");
	});

	it("keeps duplicate and invalid feedback person-facing", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		render(<CaseTypePicker onChange={vi.fn()} />);

		fireEvent.click(
			screen.getByRole("button", { name: "Case type: Pick a case type" }),
		);
		const input = await screen.findByLabelText("Create case type");
		fireEvent.change(input, { target: { value: "Client record" } });

		expect(
			screen.getByText("Client record already exists. Choose it above."),
		).toBeDefined();
		expect(
			(screen.getByRole("button", { name: "Create" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(screen.queryByText("client_record")).toBeNull();

		fireEvent.change(input, { target: { value: "---" } });
		expect(screen.getByText("Use at least one letter or number")).toBeDefined();
	});

	it("reveals stored values only when friendly labels collide", async () => {
		state.caseTypes = [{ name: "home_visit" }, { name: "home-visit" }];
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		render(<CaseTypePicker value="home_visit" onChange={vi.fn()} />);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Case type: Home visit, saved as home_visit",
			}),
		);
		expect(
			await screen.findByRole("button", {
				name: "Home visit, saved as home_visit",
			}),
		).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: "Home visit, saved as home-visit",
			}),
		).toBeDefined();
		const storedHints = screen.getAllByText("Saved as home_visit");
		for (const hint of storedHints) {
			expect(hint.className).not.toContain("font-mono");
			expect(hint.className).toContain("break-words");
		}
		for (const label of screen.getAllByText("Home visit")) {
			expect(label.className).toContain("break-words");
			expect(label.className).not.toContain("truncate");
		}
	});

	it("wraps a long selected case type instead of silently clipping it", () => {
		state.caseTypes = [
			{
				name: "household_registration_follow_up_case_for_remote_communities",
			},
		];
		render(
			<CaseTypePicker
				value="household_registration_follow_up_case_for_remote_communities"
				onChange={vi.fn()}
			/>,
		);

		const label = screen.getByText(
			"Household registration follow up case for remote communities",
		);
		expect(label.className).toContain("break-words");
		expect(label.className).not.toContain("truncate");
		expect(label.closest("button")?.className).toContain("whitespace-normal");
	});

	it("clears the selected case type from the same constrained picker", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		const onClear = vi.fn();
		render(
			<CaseTypePicker
				value="client_record"
				onChange={vi.fn()}
				onClear={onClear}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Case type: Client record" }),
		);

		const stopManaging = await screen.findByRole("button", {
			name: "Stop managing cases",
		});
		expect(stopManaging.className).toContain("bg-destructive");
		fireEvent.click(stopManaging);
		expect(onClear).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(
				document.querySelector('[data-slot="popover-content"]'),
			).toBeNull(),
		);
	});
});
