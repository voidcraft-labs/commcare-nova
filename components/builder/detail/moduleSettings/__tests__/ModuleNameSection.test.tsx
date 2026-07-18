// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModuleNameSection } from "@/components/builder/detail/moduleSettings/ModuleNameSection";
import type { Uuid } from "@/lib/doc/types";

const state = vi.hoisted(() => ({
	module: {
		uuid: "module-1" as Uuid,
		name: "Patients",
		caseListOnly: true,
	},
	updateModule: vi.fn(() => ({ ok: true as const })),
}));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: () => state.module,
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		inline: { updateModule: state.updateModule },
	}),
}));

afterEach(() => {
	cleanup();
	state.updateModule.mockClear();
	state.module.caseListOnly = true;
});

describe("ModuleNameSection", () => {
	it("keeps a bare module's real name in one conventional settings input", () => {
		render(<ModuleNameSection moduleUuid={state.module.uuid} />);

		const input = screen.getByRole("textbox", { name: "Module name" });
		expect((input as HTMLInputElement).value).toBe("Patients");
		expect(input.getAttribute("placeholder")).toBeNull();
		expect(input.getAttribute("data-slot")).toBe("input");

		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "Patient care" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(state.updateModule).toHaveBeenCalledWith(state.module.uuid, {
			name: "Patient care",
		});
	});

	it("does not duplicate the name setting for a module with its own screen", () => {
		state.module.caseListOnly = false;
		render(<ModuleNameSection moduleUuid={state.module.uuid} />);

		expect(screen.queryByRole("textbox", { name: "Module name" })).toBeNull();
	});
});
