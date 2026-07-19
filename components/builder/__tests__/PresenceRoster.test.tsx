// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceRoster } from "@/components/builder/PresenceRoster";
import { PEER_PALETTE, type Peer } from "@/lib/collab/presence";

const mocks = vi.hoisted(() => ({
	peers: [] as unknown[],
	push: vi.fn(),
}));

vi.mock("@/lib/collab/PresenceProvider", () => ({
	usePresenceRoster: () => mocks.peers,
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocShallow: (select: (state: unknown) => unknown) =>
		select({ modules: {}, forms: {}, fields: {} }),
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ push: mocks.push }),
}));

function peer(index: number, name: string): Peer {
	const peerColor = PEER_PALETTE[index % PEER_PALETTE.length];
	if (peerColor === undefined) throw new Error("Missing peer color");
	return {
		userId: `user-${index}`,
		sessionId: `session-${index}`,
		name,
		image: null,
		email: `${name.toLowerCase()}@example.com`,
		color: peerColor.id,
		location: { kind: "home" },
		updatedAt: Date.now(),
		peerColor,
	};
}

describe("PresenceRoster", () => {
	beforeEach(() => {
		mocks.peers = [
			peer(0, "Ada"),
			peer(1, "Grace"),
			peer(2, "Linus"),
			peer(3, "Margaret"),
			peer(4, "Katherine"),
		];
	});

	it("gives direct peers and the overflow menu separate 44px targets", () => {
		render(<PresenceRoster />);

		for (const name of ["Ada", "Grace", "Linus"]) {
			const trigger = screen.getByRole("button", { name: `Follow ${name}` });
			expect(trigger.className).toContain("size-11");
		}
		const overflow = screen.getByRole("button", {
			name: "2 more collaborators",
		});
		expect(overflow.className).toContain("size-11");

		const targetRow = overflow.parentElement;
		expect(targetRow?.className).toContain("gap-0.5");
		expect(targetRow?.className).not.toContain("-space-x");
	});

	it("collapses a crowded compact header to one 44px collaborator menu", () => {
		render(<PresenceRoster compact />);

		const trigger = screen.getByRole("button", {
			name: "5 collaborators here",
		});
		expect(trigger.className).toContain("size-11");
		expect(screen.queryByRole("button", { name: "Follow Ada" })).toBeNull();
		expect(screen.getByText("+4")).toBeTruthy();
	});
});
