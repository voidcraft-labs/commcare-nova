// @vitest-environment happy-dom

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { asUuid } from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/predicate";
import { CaseTargetPicker } from "../CaseTargetPicker";

const context = {
	priorCreates: [
		{
			uuid: asUuid("00000000-0000-4000-8000-000000000001"),
			label: "Referral",
		},
	],
	sessionUnavailableReason: undefined,
	newOnly: false,
	allowsNone: true,
} as const;

describe("CaseTargetPicker", () => {
	it("explains gate-rejected targets and never dispatches them", async () => {
		const onChange = vi.fn();
		render(
			<CaseTargetPicker
				value={{ kind: "session" }}
				context={context}
				ariaLabel="Which case"
				choiceVerdict={(target) =>
					target?.kind === "op"
						? {
								ok: false,
								reason: "That earlier case has a different type.",
							}
						: { ok: true }
				}
				onChange={onChange}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "Which case: The case this form opened",
		});
		fireEvent.click(trigger);
		const rejected = await screen.findByRole("menuitem", {
			name: /The case from “Referral”/,
		});
		expect((rejected as HTMLElement).getAttribute("aria-disabled")).toBe(
			"true",
		);
		expect(
			screen.getByText("That earlier case has a different type."),
		).toBeDefined();
		fireEvent.click(rejected);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(trigger);
		await waitFor(() =>
			expect(
				document.querySelector('[data-slot="dropdown-menu-popup"]'),
			).toBeNull(),
		);
	});

	it("keeps the independent self-target refusal ahead of the gate verdict", async () => {
		render(
			<CaseTargetPicker
				value={{ kind: "session" }}
				context={{ ...context, excludes: { kind: "session" } }}
				ariaLabel="Connect to"
				choiceVerdict={() => ({
					ok: false,
					reason: "A lower-priority gate reason.",
				})}
				onChange={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "Connect to: The case this form opened",
		});
		fireEvent.click(trigger);
		const session = await screen.findByRole("menuitem", {
			name: /The case this form opened/,
		});
		expect(
			within(session).getByText(
				"This is the case the change itself acts on, and a case cannot connect to itself",
			),
		).toBeDefined();
		expect(
			within(session).queryByText("A lower-priority gate reason."),
		).toBeNull();
		fireEvent.click(trigger);
		await waitFor(() =>
			expect(
				document.querySelector('[data-slot="dropdown-menu-popup"]'),
			).toBeNull(),
		);
	});

	it("renders an explicit viewer-mode trigger without evaluating edit choices", () => {
		const choiceVerdict = vi.fn(() => ({ ok: true as const }));
		render(
			<CaseTargetPicker
				value={{ kind: "session" }}
				context={context}
				ariaLabel="Which case"
				choiceVerdict={choiceVerdict}
				disabled
				onChange={vi.fn()}
			/>,
		);

		expect(
			(
				screen.getByRole("button", {
					name: "Which case: The case this form opened",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(choiceVerdict).not.toHaveBeenCalled();
	});

	it("keeps an active new target's identity key and dispatches nothing", async () => {
		const idFrom = asUuid("00000000-0000-4000-8000-000000000002");
		const value = { kind: "new" as const, idFrom };
		const choiceVerdict = vi.fn(() => ({ ok: true as const }));
		const onChange = vi.fn();
		render(
			<CaseTargetPicker
				value={value}
				context={{ ...context, newOnly: true, allowsNone: false }}
				ariaLabel="Which case"
				choiceVerdict={choiceVerdict}
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Which case: A new case" }),
		);
		await settleBaseUiTransitions();
		const active = await screen.findByRole("menuitem", {
			name: /A new case/,
		});
		fireEvent.click(active);
		await settleBaseUiTransitions();

		expect(choiceVerdict).toHaveBeenCalledWith(value);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps an active expression's exact AST and dispatches nothing", async () => {
		const expr = concat(
			term(literal("case-")),
			term(literal("existing-expression")),
		);
		const value = { kind: "expression" as const, expr };
		const choiceVerdict = vi.fn(() => ({ ok: true as const }));
		const onChange = vi.fn();
		render(
			<CaseTargetPicker
				value={value}
				context={{ ...context, allowsNone: false }}
				ariaLabel="Which case"
				choiceVerdict={choiceVerdict}
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Which case: A case found by a calculation",
			}),
		);
		await settleBaseUiTransitions();
		const active = await screen.findByRole("menuitem", {
			name: /A case found by a calculation/,
		});
		fireEvent.click(active);
		await settleBaseUiTransitions();

		expect(choiceVerdict).toHaveBeenCalledWith(value);
		expect(onChange).not.toHaveBeenCalled();
	});
});
