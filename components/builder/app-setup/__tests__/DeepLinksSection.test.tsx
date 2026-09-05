// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BuilderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import { DeepLinksSection } from "../DeepLinksSection";

const mock = vi.hoisted(() => ({
	canEdit: true,
	writeAdmission: { ok: true } as BuilderWriteAdmission,
	catalog: { kind: "unmanaged" } as {
		kind: "unmanaged" | "error";
		retry?: () => Promise<void>;
	},
	location: { kind: "app-setup", section: "deep-links" } as {
		kind: string;
		section: string;
		entryPointUuid?: string;
	},
	navigate: vi.fn(),
	add: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	entries: [] as unknown[],
	destinations: [] as unknown[],
}));
vi.mock("@/components/builder/lookup/BuilderLookupCatalogProvider", () => ({
	useBuilderLookupCatalog: () => mock.catalog,
}));
vi.mock("@/lib/doc/hooks/useEntryPoints", () => ({
	useEntryPoints: () => mock,
}));
vi.mock("@/lib/routing/hooks", () => ({
	useLocation: () => mock.location,
	useNavigate: () => ({ openAppSetup: mock.navigate }),
}));
vi.mock("@/lib/session/hooks", () => ({ useCanEdit: () => mock.canEdit }));
vi.mock("@/components/preview/EntryPointPreviewLaunch", () => ({
	EntryPointPreviewLaunch: () => <div>Preview launch</div>,
}));
const uuid = testUuid("ui-deep-link");
const moduleUuid = testUuid("ui-deep-module");
const destination = {
	target: { kind: "module", moduleUuid },
	label: "Patients · Module",
	requiredSelections: [],
	issue: undefined,
};
beforeEach(() => {
	vi.clearAllMocks();
	mock.canEdit = true;
	mock.writeAdmission = { ok: true };
	mock.catalog = { kind: "unmanaged" };
	mock.location = { kind: "app-setup", section: "deep-links" };
	mock.entries = [];
	mock.destinations = [destination];
	mock.add.mockReturnValue({ ok: true, uuid });
});
describe("deep links workspace", () => {
	it("creates an explicit destination and opens its canonical identity", () => {
		render(<DeepLinksSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add deep link" }));
		fireEvent.click(screen.getByRole("button", { name: destination.label }));
		expect(mock.add).toHaveBeenCalledWith(destination.target);
		expect(mock.navigate).toHaveBeenCalledWith("deep-links", uuid);
	});
	it("retains destinations and shows a refused creation", () => {
		mock.add.mockReturnValue({
			ok: false,
			messages: ["Destination changed. Review it and try again."],
		});
		render(<DeepLinksSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add deep link" }));
		fireEvent.click(screen.getByRole("button", { name: destination.label }));
		expect(screen.getByRole("alert").textContent).toContain(
			"Destination changed",
		);
		expect(
			screen.getByRole("button", { name: destination.label }),
		).toBeDefined();
		expect(mock.navigate).not.toHaveBeenCalled();
	});
	it("retains the typed ID after a refused update", () => {
		mock.entries = [{ ...destination, entryPoint: { uuid, id: "patients" } }];
		mock.location.entryPointUuid = uuid;
		mock.update.mockReturnValue({
			ok: false,
			messages: ["This ID is already used."],
		});
		render(<DeepLinksSection />);
		const input = screen.getByLabelText("Link ID");
		fireEvent.change(input, { target: { value: "other" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect((input as HTMLInputElement).value).toBe("other");
		expect(screen.getByText("This ID is already used.")).toBeDefined();
	});
	it("keeps every authoring control disabled until Project data is ready", () => {
		mock.entries = [
			{
				...destination,
				target: { kind: "form", moduleUuid, formUuid: testUuid("detail-form") },
				entryPoint: { uuid, id: "patients" },
			},
		];
		mock.location.entryPointUuid = uuid;
		mock.writeAdmission = {
			ok: false,
			messages: [
				"Project data is still loading. Wait for it to finish before editing this app.",
			],
		};
		const mounted = render(<DeepLinksSection />);
		expect(
			(screen.getByLabelText("Link ID") as HTMLInputElement).disabled,
		).toBe(true);
		expect(screen.getByRole("switch").getAttribute("aria-disabled")).toBe(
			"true",
		);
		fireEvent.click(screen.getByRole("switch"));
		expect(mock.update).not.toHaveBeenCalled();
		const remove = screen.getByRole("button", { name: "Remove deep link" });
		expect((remove as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(remove);
		expect(mock.remove).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toContain(
			"Project data is still loading",
		);
		mock.writeAdmission = { ok: true };
		mounted.rerender(<DeepLinksSection />);
		expect(
			(screen.getByLabelText("Link ID") as HTMLInputElement).disabled,
		).toBe(false);
		expect(
			(
				screen.getByRole("button", {
					name: "Remove deep link",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect(screen.queryByRole("status")).toBeNull();
	});
	it("disables creation while a catalog refresh is pending, retaining the open choices", () => {
		const mounted = render(<DeepLinksSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add deep link" }));
		mock.writeAdmission = {
			ok: false,
			messages: ["Project data is still loading."],
		};
		mounted.rerender(<DeepLinksSection />);
		const choice = screen.getByRole("button", { name: destination.label });
		expect((choice as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(choice);
		expect(mock.add).not.toHaveBeenCalled();
		mock.writeAdmission = { ok: true };
		mounted.rerender(<DeepLinksSection />);
		expect(
			(
				screen.getByRole("button", {
					name: destination.label,
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});
	it("offers catalog retry while keeping failed-load authoring disabled", () => {
		const retry = vi.fn().mockResolvedValue(undefined);
		mock.catalog = { kind: "error", retry };
		mock.writeAdmission = {
			ok: false,
			messages: [
				"Nova could not load this Project's data-table definitions. Try again before editing this app.",
			],
		};
		render(<DeepLinksSection />);
		expect(
			(
				screen.getByRole("button", {
					name: "Add deep link",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(screen.getByRole("alert").textContent).toContain("could not load");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalledOnce();
		expect(mock.add).not.toHaveBeenCalled();
	});
	it("keeps viewer configuration read-only while allowing Preview", () => {
		mock.entries = [{ ...destination, entryPoint: { uuid, id: "patients" } }];
		mock.location.entryPointUuid = uuid;
		mock.canEdit = false;
		render(<DeepLinksSection />);
		expect(
			(screen.getByLabelText("Link ID") as HTMLInputElement).disabled,
		).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Remove deep link" }),
		).toBeNull();
		expect(screen.getByText("Preview launch")).toBeDefined();
	});
});
