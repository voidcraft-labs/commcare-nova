// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accessPhase: "authorized" as
		| "authorized"
		| "refreshing"
		| "reconnecting"
		| "upgradeRequired"
		| "revoked",
	/* `BuilderPhase.Ready` — spelled by value because `vi.hoisted` runs before
	 * any import. Every case here has an app, so the mark stands alone. */
	phase: "ready",
	appId: "app-under-test" as string | undefined,
	canEdit: true,
	compact: true,
	ultraCompact: false,
	undo: vi.fn(),
	redo: vi.fn(),
}));

vi.mock("@/components/builder/AccessStatus", () => ({
	BuilderAccessStatus: () => <span data-testid="access-status" />,
}));
vi.mock("@/components/builder/PublishPanel", () => ({
	PublishPanel: () => <button type="button">Publish</button>,
}));
vi.mock("@/components/builder/PresenceRoster", () => ({
	PresenceRoster: ({ compact }: { compact?: boolean }) => (
		<button type="button" data-compact={compact || undefined}>
			5 collaborators here
		</button>
	),
}));
vi.mock("@/components/builder/PreviewToggle", () => ({
	PreviewToggle: () => <button type="button">Preview</button>,
}));
vi.mock("@/components/builder/localization/LanguageSelector", () => ({
	LanguageSelector: () => <button type="button">English en</button>,
}));
vi.mock("@/components/builder/SaveIndicator", () => ({
	SaveIndicator: ({ compact }: { compact?: boolean }) => (
		<span data-testid="save-status" data-compact={compact || undefined} />
	),
}));
vi.mock("@/lib/doc/hooks/useDocHasData", () => ({
	useDocHasData: () => true,
}));
vi.mock("@/lib/doc/hooks/useUndoRedo", () => ({
	useCanRedo: () => true,
	useCanUndo: () => true,
}));
vi.mock("@/lib/routing/builderActions", () => ({
	useUndoRedo: () => ({ undo: mocks.undo, redo: mocks.redo }),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAccessPhase: () => mocks.accessPhase,
	useAppId: () => mocks.appId,
	useBuilderIsReady: () => true,
	useBuilderPhase: () => mocks.phase,
	useCanEdit: () => mocks.canEdit,
	useProjectScopeEpoch: () => 0,
	/* The identity menu beside the Preview toggle reads these. It renders
	 * nothing outside Preview, which is the state this suite measures the
	 * header in, so the toggle's own width is what the layout assertions
	 * see either way. */
	usePreviewing: () => false,
	usePreviewPersonaUuid: () => undefined,
	useSetPreviewPersonaUuid: () => () => {},
}));
vi.mock("@/lib/ui/hooks/useIsBreakpoint", () => ({
	useIsBreakpoint: (_mode: string, breakpoint: number) =>
		breakpoint === 1100
			? mocks.compact
			: breakpoint === 560
				? mocks.ultraCompact
				: false,
}));

import { BuilderHeader } from "@/components/builder/BuilderHeader";
import {
	type HeaderClaim,
	HeaderSlotsProvider,
} from "@/components/ui/headerSlots";

/**
 * The builder renders no header of its own: it claims the shared band and
 * portals its controls into it. So the band stands in here as two host
 * elements plus a claim recorder, and the assertions are about what the
 * builder PUTS THERE — the mark, the account control, and the band's own
 * geometry belong to `AppChrome`.
 */
function renderIntoBand(
	props: Partial<Parameters<typeof BuilderHeader>[0]> = {},
) {
	const claims: (HeaderClaim | null)[] = [];
	const center = document.createElement("div");
	const actions = document.createElement("div");
	document.body.append(center, actions);

	const slots = {
		center,
		actions,
		claim: (claim: HeaderClaim | null) => {
			claims.push(claim);
		},
	};
	/* A FRESH element each time: React bails out of a re-render when handed the
	 * identical element object, and these cases turn on mocked hooks rather
	 * than props. */
	const element = () => (
		<HeaderSlotsProvider value={slots}>
			<BuilderHeader onSetPreviewing={() => {}} {...props} />
		</HeaderSlotsProvider>
	);
	const view = render(element());
	hosts.push(center, actions);
	return {
		view,
		center,
		actions,
		rerender: () => view.rerender(element()),
		/** The claim standing after the last commit. */
		latest: () => claims[claims.length - 1],
	};
}

/** Portal hosts live on `document.body`, which RTL's unmount does not clean. */
const hosts: HTMLElement[] = [];

describe("BuilderHeader responsive actions", () => {
	afterEach(() => {
		for (const host of hosts.splice(0)) host.remove();
	});

	beforeEach(() => {
		mocks.accessPhase = "authorized";
		mocks.phase = "ready";
		mocks.appId = "app-under-test";
		mocks.canEdit = true;
		mocks.compact = true;
		mocks.ultraCompact = false;
	});

	it("keeps the centered preview and every document tool reachable with compact peers", () => {
		const band = renderIntoBand();

		// Once an app exists the builder asks the band for the mark alone: the
		// app being built carries the name on this screen.
		expect(band.latest()).toMatchObject({
			homeLabel: "Back to your apps",
			markOnly: true,
			stacked: false,
			showAccount: true,
			/* This page opened with an app, so nothing changed hands and there is
			 * no gesture to play. */
			handoff: false,
		});
		/* Omitted, never `false`: the file manager defers to the live session
		 * capability, and an explicit `false` would make an editor read-only. */
		expect(band.latest()).not.toHaveProperty("canManageFiles");
		expect(
			screen.getByRole("button", { name: "5 collaborators here" }).dataset
				.compact,
		).toBe("true");
		expect(screen.getByTestId("save-status").dataset.compact).toBe("true");
		const history = screen.getByRole("button", { name: "Edit history" });
		expect(history.className).toContain("size-11");
		expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
		// Preview goes dead centre; every document tool goes to the right.
		expect(
			band.center.contains(screen.getByRole("button", { name: "Preview" })),
		).toBe(true);
		expect(
			band.actions.contains(screen.getByRole("button", { name: "Publish" })),
		).toBe(true);
		expect(band.actions.contains(history)).toBe(true);
	});

	it("asks for a second row on very narrow screens rather than shrinking anything", () => {
		mocks.ultraCompact = true;
		const band = renderIntoBand();

		expect(band.latest()).toMatchObject({ markOnly: true, stacked: true });
		expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Edit history" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
	});

	it("keeps the autosave owner mounted while access refreshes and reconnects", () => {
		const band = renderIntoBand();
		const saveOwner = screen.getByTestId("save-status");

		mocks.accessPhase = "refreshing";
		band.rerender();
		expect(screen.getByTestId("save-status")).toBe(saveOwner);
		expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
		// The account control lives in the band, so the quarantine is a claim.
		expect(band.latest()).toMatchObject({ showAccount: false });

		mocks.accessPhase = "reconnecting";
		band.rerender();
		expect(screen.getByTestId("save-status")).toBe(saveOwner);
		expect(band.latest()).toMatchObject({ showAccount: false });

		mocks.accessPhase = "authorized";
		band.rerender();
		expect(screen.getByTestId("save-status")).toBe(saveOwner);
		expect(band.latest()).toMatchObject({ showAccount: true });
	});
});
