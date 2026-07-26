// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid, type Persona } from "@/lib/domain";

const { removePersona, countCasesOwnedByAction } = vi.hoisted(() => ({
	removePersona: vi.fn(),
	countCasesOwnedByAction: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({ removePersona }),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app",
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => ({ canEdit: true }),
	}),
}));
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	countCasesOwnedByAction,
}));

import { PersonaRemoveConfirm } from "../PersonaRemoveConfirm";

const PERSONA: Persona = {
	uuid: asUuid("persona-a"),
	name: "Asha",
};

function renderConfirm() {
	return render(
		<PersonaRemoveConfirm
			persona={PERSONA}
			returnFocusRef={createRef<HTMLButtonElement>()}
		/>,
	);
}

beforeEach(() => {
	removePersona.mockReset();
	countCasesOwnedByAction.mockReset();
});

describe("PersonaRemoveConfirm", () => {
	it("does not allow removal until the complete retained-row count is known", async () => {
		let resolveCount:
			| ((value: { kind: "count"; count: number }) => void)
			| undefined;
		countCasesOwnedByAction.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveCount = resolve;
			}),
		);
		renderConfirm();
		fireEvent.click(screen.getByRole("button", { name: "Remove persona" }));

		expect(
			screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled"),
		).toBe(true);
		expect(countCasesOwnedByAction).toHaveBeenCalledWith({
			appId: "app",
			personaUuid: PERSONA.uuid,
		});

		resolveCount?.({ kind: "count", count: 3 });
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled"),
			).toBe(false),
		);
	});

	it("blocks on a failed count and retries before removal", async () => {
		countCasesOwnedByAction
			.mockResolvedValueOnce({ kind: "error", message: "offline" })
			.mockResolvedValueOnce({ kind: "count", count: 2 });
		renderConfirm();
		fireEvent.click(screen.getByRole("button", { name: "Remove persona" }));

		const retry = await screen.findByRole("button", { name: "Try again" });
		expect(
			screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.click(retry);

		await waitFor(() =>
			expect(screen.getByText(/2 retained case rows/i)).toBeDefined(),
		);
		expect(
			screen.getByText(/Nova does not delete or reassign them/i),
		).toBeDefined();
		expect(
			screen.getByText(/unfiltered case lists may still show them/i),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("turns a rejected count promise into the retry state", async () => {
		countCasesOwnedByAction
			.mockRejectedValueOnce(new Error("network failed"))
			.mockResolvedValueOnce({ kind: "count", count: 1 });
		renderConfirm();
		fireEvent.click(screen.getByRole("button", { name: "Remove persona" }));

		const retry = await screen.findByRole("button", { name: "Try again" });
		expect(
			screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.click(retry);

		await screen.findByText(/1 retained case row/i);
		expect(countCasesOwnedByAction).toHaveBeenCalledTimes(2);
	});

	it("removes only after a known zero count", async () => {
		countCasesOwnedByAction.mockResolvedValueOnce({
			kind: "count",
			count: 0,
		});
		renderConfirm();
		fireEvent.click(screen.getByRole("button", { name: "Remove persona" }));
		await screen.findByText("Asha owns no retained case rows.");

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));

		expect(removePersona).toHaveBeenCalledWith(PERSONA.uuid);
	});
});
