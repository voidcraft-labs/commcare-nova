// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleCaseTypeSection } from "@/components/builder/detail/moduleSettings/ModuleCaseTypeSection";
import type { Uuid } from "@/lib/doc/types";

const state = vi.hoisted(() => ({
	formIds: ["form-1"] as string[],
	module: { uuid: "module-1", caseType: "client" } as {
		uuid: string;
		caseType?: string;
	},
	updateModule: vi.fn(),
}));

vi.mock("@/components/builder/shared/CaseTypePicker", () => ({
	CaseTypePicker: ({
		value,
		onChange,
		onClear,
		triggerRef,
	}: {
		value?: string;
		onChange: (value: string) => void;
		onClear?: () => void;
		triggerRef?: Ref<HTMLButtonElement>;
	}) => (
		<div>
			<button type="button" ref={triggerRef}>
				Current case type: {value ?? "None"}
			</button>
			<button type="button" onClick={() => onChange("client")}>
				Choose Client
			</button>
			<button type="button" onClick={() => onChange("visit")}>
				Choose Visit
			</button>
			<button type="button" onClick={onClear}>
				Request clear
			</button>
		</div>
	),
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		inline: { updateModule: state.updateModule },
	}),
}));
vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: () => state.module,
}));
vi.mock("@/lib/doc/hooks/useModuleIds", () => ({
	useFormIds: () => state.formIds,
}));

beforeEach(() => {
	state.formIds = ["form-1"];
	state.module = { uuid: "module-1", caseType: "client" };
	state.updateModule.mockReset();
	state.updateModule.mockReturnValue({ ok: true, messages: [] });
});

describe("ModuleCaseTypeSection", () => {
	it("keeps everyday help short and puts clear consequences in confirmation", async () => {
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		expect(
			screen.getByText("Choose the kind of case this module works with"),
		).toBeDefined();
		expect(screen.queryByText(/turns this module/i)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Request clear" }));
		expect(
			await screen.findByRole("heading", { name: "Stop managing cases?" }),
		).toBeDefined();
		expect(
			screen.getByText(
				/removes this module's Search, Results, and Details setup/i,
			),
		).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Stop managing" }));
		expect(state.updateModule).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Stop managing cases?" }),
			).toBeNull(),
		);
	});

	it("keeps a rejected clear explanation inside the confirmation state", async () => {
		state.updateModule.mockReturnValue({
			ok: false,
			messages: ["A case form still uses this case type."],
		});
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Request clear" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Stop managing" }),
		);
		expect((await screen.findByRole("alert")).textContent).toContain(
			"A case form still uses this case type.",
		);
		expect(
			screen.getByRole("heading", { name: "Stop managing cases?" }),
		).toBeDefined();
	});

	it("explains why a formless module cannot clear instead of offering a dead action", async () => {
		state.formIds = [];
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Request clear" }));
		expect(
			await screen.findByRole("heading", { name: "Add a form first" }),
		).toBeDefined();
		expect(screen.getByText(/module has no forms/i)).toBeDefined();
		expect(screen.queryByRole("button", { name: "Stop managing" })).toBeNull();
		expect(state.updateModule).not.toHaveBeenCalled();

		// Let Base UI's initial-focus task settle before closing, then wait for
		// its focus-restoration work so the leak gate sees a quiescent dialog.
		await Promise.resolve();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Add a form first" }),
			).toBeNull(),
		);
	});

	it("assigns a case type directly when the module does not have one", () => {
		state.module = { uuid: "module-1" };
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Choose Visit" }));

		expect(state.updateModule).toHaveBeenCalledTimes(1);
		expect(state.updateModule).toHaveBeenCalledWith(
			"module-1",
			expect.objectContaining({ caseType: "visit" }),
		);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("does nothing when the current case type is chosen again", () => {
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Choose Client" }));

		expect(state.updateModule).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("explains a case-type switch before applying it", async () => {
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Choose Visit" }));

		expect(state.updateModule).not.toHaveBeenCalled();
		expect(
			await screen.findByRole("heading", { name: "Switch to Visit cases?" }),
		).toBeDefined();
		expect(
			screen.getByText(/current layout and rules stay in place/i),
		).toBeDefined();
		expect(
			screen.getByText(/Existing Client cases aren't deleted/i),
		).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(state.updateModule).not.toHaveBeenCalled();
	});

	it("applies a confirmed case-type switch", async () => {
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Choose Visit" }));
		fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

		expect(state.updateModule).toHaveBeenCalledWith(
			"module-1",
			expect.objectContaining({ caseType: "visit" }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("keeps a rejected switch explanation inside the confirmation", async () => {
		state.updateModule.mockReturnValue({
			ok: false,
			messages: ["A Results rule does not work with Visit cases."],
		});
		render(<ModuleCaseTypeSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(screen.getByRole("button", { name: "Choose Visit" }));
		fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

		expect((await screen.findByRole("alert")).textContent).toContain(
			"A Results rule does not work with Visit cases.",
		);
		expect(
			screen.getByRole("heading", { name: "Switch to Visit cases?" }),
		).toBeDefined();
	});
});
