// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	signOut: vi.fn(),
}));

vi.mock("@/components/builder/media/MediaPickerDialog", () => ({
	MediaPickerDialog: ({ canWrite }: { canWrite?: boolean }) => (
		<span data-testid="file-manager" data-can-write={String(canWrite)} />
	),
}));

vi.mock("@/lib/auth/hooks/useAuth", () => ({
	useAuth: () => ({
		user: {
			id: "user-1",
			name: "A deliberately long account name that must remain readable",
			email: "a-deliberately-long-address-without-breaks@example.dimagi.com",
			image: null,
		},
		isAuthenticated: true,
		isPending: false,
		signOut: mocks.signOut,
	}),
}));

vi.mock("@/lib/credits/useCreditBalance", () => ({
	useCreditBalance: () => ({
		summary: { balance: 8, consumed: 2 },
		refresh: mocks.refresh,
	}),
}));

describe("AccountMenu", () => {
	beforeEach(() => {
		mocks.refresh.mockReset();
		mocks.signOut.mockReset();
	});

	it("uses shared 44px controls and keeps account values readable", async () => {
		render(<AccountMenu canManageFiles={false} />);

		const trigger = await screen.findByRole("button", {
			name: "Account menu",
		});
		expect(trigger.className).toContain("size-11");

		fireEvent.click(trigger);
		expect(await screen.findByRole("dialog", { name: "Account" })).toBeTruthy();

		const accountName = screen.getByText(
			"A deliberately long account name that must remain readable",
		);
		expect(accountName.className).toContain("[overflow-wrap:anywhere]");
		expect(accountName.className).not.toContain("truncate");

		expect(screen.getByRole("button", { name: "Files" }).className).toContain(
			"h-11",
		);
		expect(screen.getByRole("link", { name: "Settings" }).className).toContain(
			"h-11",
		);
		expect(
			screen.getByRole("button", { name: "Sign out" }).className,
		).toContain("h-11");
		expect(screen.getByTestId("file-manager").dataset.canWrite).toBe("false");
	});
});
