// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	narrow: false,
	handset: false,
	compact: false,
	previewing: false,
	reduceMotion: false,
	structureOpen: true,
	chatOpen: true,
	inspectorActive: false,
	setSidebarOpen: vi.fn(),
	closeInspector: vi.fn(),
}));

vi.mock("motion/react", () => ({
	AnimatePresence: ({ children }: { children: ReactNode }) => children,
	useReducedMotion: () => mocks.reduceMotion,
	motion: {
		div: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
			function MotionDiv({ children, ...props }, ref) {
				/* Motion-only props are intentionally omitted from this DOM test. */
				const {
					// @ts-expect-error motion props are not HTML attributes
					initial: _initial,
					// @ts-expect-error motion props are not HTML attributes
					animate: _animate,
					// @ts-expect-error motion props are not HTML attributes
					exit: _exit,
					// @ts-expect-error motion props are not HTML attributes
					transition: _transition,
					...domProps
				} = props;
				const motionX =
					typeof _animate === "object" && _animate !== null && "x" in _animate
						? String((_animate as { readonly x?: unknown }).x)
						: undefined;
				return (
					<div ref={ref} data-motion-x={motionX} {...domProps}>
						{children}
					</div>
				);
			},
		),
	},
}));

vi.mock("@/components/builder/appTree/AppTreeRail", () => ({
	AppTreeRail: ({ onExpand }: { onExpand: () => void }) => (
		<button
			type="button"
			onClick={onExpand}
			aria-label="Expand structure sidebar"
			data-builder-sidebar-toggle="expand-structure"
		>
			Expand structure
		</button>
	),
}));

vi.mock("@/components/builder/BreadcrumbStrip", () => ({
	BreadcrumbStrip: () => <div>Breadcrumbs</div>,
}));

vi.mock("@/components/builder/ContentFrame", () => ({
	ModeFlipGlideProvider: ({ children }: { children: ReactNode }) => children,
	SIDEBAR_TRANSITION: { duration: 0 },
}));

vi.mock("@/components/builder/GenerationProgress", () => ({
	GenerationProgress: () => <div>Progress</div>,
}));

vi.mock("@/components/builder/StructureSidebar", () => ({
	StructureSidebar: () => (
		<div data-testid="structure-sidebar">
			Structure
			<button
				type="button"
				onClick={() => mocks.setSidebarOpen("structure", false)}
				aria-label="Collapse structure sidebar"
				data-builder-sidebar-toggle="collapse-structure"
			/>
		</div>
	),
}));

vi.mock("@/components/chat/ChatContainer", () => ({
	ChatContainer: () => (
		<div data-testid="chat-container">
			Chat
			<button
				type="button"
				onClick={() => mocks.setSidebarOpen("chat", false)}
				aria-label="Collapse chat sidebar"
				data-builder-sidebar-toggle="collapse-chat"
			/>
		</div>
	),
}));

vi.mock("@/components/chat/ChatRail", () => ({
	ChatRail: ({ onExpand }: { onExpand: () => void }) => (
		<button
			type="button"
			onClick={onExpand}
			aria-label="Expand chat sidebar"
			data-builder-sidebar-toggle="expand-chat"
		>
			Expand chat
		</button>
	),
}));

vi.mock("@/components/preview/PreviewShell", () => ({
	PreviewShell: () => (
		<main>
			Canvas
			<button type="button" aria-label="Selected case field" />
		</main>
	),
}));

vi.mock("@/components/ui/ErrorBoundary", () => ({
	ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/doc/hooks/useDocHasData", () => ({
	useDocHasData: () => true,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ back: vi.fn() }),
}));

vi.mock("@/lib/session/hooks", () => ({
	useBuilderPhase: () => "ready",
	useBuilderIsReady: () => true,
	usePreviewing: () => mocks.previewing,
	useSetSidebarOpen: () => mocks.setSidebarOpen,
	useSidebarState: (kind: "chat" | "structure") => ({
		open: kind === "chat" ? mocks.chatOpen : mocks.structureOpen,
	}),
}));

vi.mock("@/lib/ui/hooks/useIsBreakpoint", () => ({
	useIsBreakpoint: (_mode: string, breakpoint: number) =>
		breakpoint === 560
			? mocks.handset
			: breakpoint === 960
				? mocks.narrow
				: mocks.compact,
}));

vi.mock("@/lib/ui/inspector", () => ({
	COMPACT_BUILDER_RAIL_BREAKPOINT: 1200,
	COMPACT_INSPECTOR_RAIL_WIDTH: 300,
	INSPECTOR_RAIL_WIDTH: 360,
}));

vi.mock("@/components/builder/inspector/activeInspector", () => ({
	useInspectorPresence: () => ({
		docked: mocks.inspectorActive,
		requestClose: mocks.closeInspector,
	}),
}));

import { BuilderContentArea } from "../BuilderContentArea";

function renderArea() {
	return render(<BuilderContentArea isCentered={false} isExistingApp={true} />);
}

function flank(name: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		`[data-builder-flank="${name}"]`,
	);
	if (!element) throw new Error(`Missing ${name} flank`);
	return element;
}

beforeEach(() => {
	mocks.narrow = false;
	mocks.handset = false;
	mocks.compact = false;
	mocks.previewing = false;
	mocks.reduceMotion = false;
	mocks.structureOpen = true;
	mocks.chatOpen = true;
	mocks.inspectorActive = false;
	mocks.setSidebarOpen.mockReset();
	mocks.closeInspector.mockReset();
});

describe("BuilderContentArea responsive flanks", () => {
	it("leaves the PreviewShell as the single main landmark", () => {
		const { container } = renderArea();

		expect(screen.getByRole("main").textContent).toBe("Canvas");
		expect(container.querySelectorAll("main")).toHaveLength(1);
	});

	it("keeps the established desktop and compact-desktop widths", () => {
		const { rerender } = renderArea();

		expect(flank("structure").style.width).toBe("360px");
		expect(flank("chat-spacer").style.width).toBe("360px");
		expect(
			document
				.querySelector("[data-builder-layout]")
				?.getAttribute("data-builder-layout"),
		).toBe("desktop");

		mocks.compact = true;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);

		expect(flank("structure").style.width).toBe("300px");
		expect(flank("chat-spacer").style.width).toBe("300px");
	});

	it("hands desktop structure focus to the reciprocal visible toggle", async () => {
		const { rerender } = renderArea();
		const collapse = screen.getByRole("button", {
			name: "Collapse structure sidebar",
		});
		collapse.focus();
		fireEvent.click(collapse);

		mocks.structureOpen = false;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		const expand = screen.getByRole("button", {
			name: "Expand structure sidebar",
		});
		await waitFor(() => expect(document.activeElement).toBe(expand));

		fireEvent.click(expand);
		mocks.structureOpen = true;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", {
					name: "Collapse structure sidebar",
				}),
			),
		);
	});

	it("hands reduced-motion desktop chat focus to the reciprocal visible toggle", async () => {
		mocks.reduceMotion = true;
		const { rerender } = renderArea();
		const collapse = screen.getByRole("button", {
			name: "Collapse chat sidebar",
		});
		collapse.focus();
		fireEvent.click(collapse);

		mocks.chatOpen = false;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		const expand = screen.getByRole("button", {
			name: "Expand chat sidebar",
		});
		await waitFor(() => expect(document.activeElement).toBe(expand));

		fireEvent.click(expand);
		mocks.chatOpen = true;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Collapse chat sidebar" }),
			),
		);
	});

	it("clips the keep-mounted parked Chat panel inside the desktop builder row", () => {
		mocks.chatOpen = false;
		const { container } = renderArea();

		const layout = container.querySelector<HTMLElement>(
			'[data-builder-layout="desktop"]',
		);
		const panel = document.querySelector<HTMLElement>(
			"[data-builder-chat-panel]",
		);
		const viewport = panel?.closest<HTMLElement>(
			'[data-slot="drawer-viewport"]',
		);
		const portal = viewport?.closest<HTMLElement>(
			'[data-slot="drawer-portal"]',
		);
		expect(layout?.classList.contains("overflow-hidden")).toBe(true);
		expect(viewport?.classList.contains("overflow-clip")).toBe(true);
		expect(layout?.contains(viewport ?? null)).toBe(true);
		expect(portal?.parentElement).toBe(layout);
		expect(panel?.getAttribute("data-motion-x")).toBe("100%");
		expect(panel?.hasAttribute("inert")).toBe(true);
		expect(panel?.style.width).toBe("360px");
	});

	it("starts narrow viewports with two live icon rails and preserves the canvas", () => {
		mocks.narrow = true;
		mocks.compact = true;
		renderArea();

		expect(flank("structure").style.width).toBe("56px");
		expect(flank("chat").style.width).toBe("56px");
		expect(flank("chat-spacer").style.width).toBe("0px");
		expect(
			screen.getByRole("button", { name: "Expand structure sidebar" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Expand chat sidebar" }),
		).toBeTruthy();
		expect(screen.queryByTestId("structure-sidebar")).toBeNull();
		expect(document.querySelector("[data-builder-overlay]")).toBeNull();
	});

	it("gives handsets the full canvas width and keeps both panels in a bottom dock", () => {
		mocks.handset = true;
		mocks.narrow = true;
		mocks.compact = true;
		renderArea();

		expect(flank("chat-spacer").style.width).toBe("0px");
		expect(
			document.querySelector('[data-builder-flank="structure"]'),
		).toBeNull();
		expect(document.querySelector('[data-builder-flank="chat"]')).toBeNull();
		expect(
			document
				.querySelector("[data-builder-layout]")
				?.getAttribute("data-builder-layout"),
		).toBe("handset");

		const dock = screen.getByRole("navigation", { name: "Builder panels" });
		expect(dock.className).toContain("h-14");
		const app = screen.getByRole("button", { name: "Open app structure" });
		const chat = screen.getByRole("button", { name: "Open chat" });
		expect(app.className).toContain("h-11");
		expect(chat.className).toContain("h-11");
		expect(app.textContent).toContain("App");
		expect(chat.textContent).toContain("Chat");
		expect(
			document.querySelector("[data-builder-canvas]")?.className,
		).toContain("pb-14");
	});

	it("opens handset drawers from the dock and restores focus to their visible actions", async () => {
		mocks.handset = true;
		mocks.narrow = true;
		mocks.compact = true;
		renderArea();

		const app = screen.getByRole("button", { name: "Open app structure" });
		app.focus();
		fireEvent.click(app);
		expect(screen.getByRole("dialog", { name: "App structure" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(app));

		const chat = screen.getByRole("button", { name: "Open chat" });
		chat.focus();
		fireEvent.click(chat);
		expect(screen.getByRole("dialog", { name: "Chat" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(chat));
	});

	it("gives a reduced-motion Chat drawer one-Escape dismissal", async () => {
		mocks.narrow = true;
		mocks.compact = true;
		mocks.reduceMotion = true;
		mocks.chatOpen = false;
		const { rerender } = renderArea();

		const trigger = screen.getByRole("button", {
			name: "Expand chat sidebar",
		});
		trigger.focus();
		fireEvent.click(trigger);
		mocks.chatOpen = true;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);

		await waitFor(() => {
			expect(document.activeElement).toBe(
				document.querySelector("[data-builder-chat-panel]"),
			);
			expect(document.activeElement).not.toBe(
				screen.getByRole("button", { name: "Collapse chat sidebar" }),
			);
		});

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Expand chat sidebar" }),
			),
		);
	});

	it("opens one modal drawer at a time without remounting the chat stream", async () => {
		mocks.narrow = true;
		mocks.compact = true;
		renderArea();
		const chat = screen.getByTestId("chat-container");

		const structureTrigger = screen.getByRole("button", {
			name: "Expand structure sidebar",
		});
		structureTrigger.focus();
		fireEvent.click(structureTrigger);
		expect(screen.getByTestId("structure-sidebar")).toBeTruthy();
		expect(screen.getByRole("dialog", { name: "App structure" })).toBeTruthy();
		const structureOverlay = document.querySelector(
			'[data-builder-overlay="structure"]',
		);
		expect(structureOverlay).not.toBeNull();
		expect(flank("structure").classList.contains("z-raised")).toBe(true);
		expect(
			document
				.querySelector("[data-builder-canvas]")
				?.classList.contains("z-ground"),
		).toBe(true);
		expect(flank("structure").style.width).toBe("56px");

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => {
			expect(screen.queryByTestId("structure-sidebar")).toBeNull();
			expect(document.activeElement).toBe(structureTrigger);
		});
		const chatTrigger = screen.getByRole("button", {
			name: "Expand chat sidebar",
		});
		chatTrigger.focus();
		fireEvent.click(chatTrigger);
		expect(screen.queryByTestId("structure-sidebar")).toBeNull();
		expect(
			document.querySelector('[data-builder-overlay="right"]'),
		).not.toBeNull();
		expect(screen.getByTestId("chat-container")).toBe(chat);
		expect(screen.getByRole("dialog", { name: "Chat" })).toBeTruthy();
		expect(mocks.setSidebarOpen).toHaveBeenNthCalledWith(1, "structure", true);
		expect(mocks.setSidebarOpen).toHaveBeenNthCalledWith(2, "chat", true);

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() =>
			expect(document.activeElement?.getAttribute("aria-label")).toBe(
				"Expand chat sidebar",
			),
		);
	});

	it("opens an inspector as a modal drawer and dismisses it before structure", async () => {
		mocks.narrow = true;
		mocks.compact = true;
		const { rerender } = renderArea();
		const inspectorOrigin = screen.getByRole("button", {
			name: "Selected case field",
		});
		inspectorOrigin.setAttribute("data-inspector-return-focus", "");

		mocks.inspectorActive = true;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		expect(
			document.querySelector('[data-builder-overlay="right"]'),
		).not.toBeNull();
		expect(screen.getByRole("dialog", { name: "Properties" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(mocks.closeInspector).toHaveBeenCalledTimes(1));

		mocks.inspectorActive = false;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		await waitFor(() => expect(document.activeElement).toBe(inspectorOrigin));
		expect(inspectorOrigin.hasAttribute("data-inspector-return-focus")).toBe(
			false,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Expand structure sidebar" }),
		);
		expect(
			document.querySelector('[data-builder-overlay="structure"]'),
		).not.toBeNull();
	});

	it("dismisses Properties instead of replacing it with Chat when a center workbench opens", async () => {
		mocks.narrow = true;
		mocks.compact = true;
		const { rerender } = renderArea();
		const workbenchOrigin = screen.getByRole("button", {
			name: "Selected case field",
		});

		mocks.inspectorActive = true;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		expect(screen.getByRole("dialog", { name: "Properties" })).toBeTruthy();

		/* SearchConditionCanvas marks and focuses its Back action as it replaces
		 * the inspector-owned view in the center canvas. */
		workbenchOrigin.setAttribute("data-inspector-return-focus", "");
		mocks.inspectorActive = false;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);

		await waitFor(() => {
			expect(
				document.querySelector('[data-builder-overlay="right"]'),
			).toBeNull();
			expect(screen.queryByRole("dialog", { name: "Chat" })).toBeNull();
			expect(document.activeElement).toBe(workbenchOrigin);
		});
	});

	it("keeps the centered welcome visible on a narrow new-build layout", () => {
		mocks.narrow = true;
		mocks.compact = true;
		render(<BuilderContentArea isCentered isExistingApp={false} />);

		expect(screen.getByTestId("chat-container")).toBeTruthy();
		expect(
			document
				.querySelector("[data-builder-chat-panel]")
				?.hasAttribute("inert"),
		).toBe(false);
	});

	it("returns to the rail when the expanded sidebar closes", async () => {
		mocks.narrow = true;
		mocks.compact = true;
		const { rerender } = renderArea();

		fireEvent.click(
			screen.getByRole("button", { name: "Expand structure sidebar" }),
		);
		expect(screen.getByTestId("structure-sidebar")).toBeTruthy();

		mocks.structureOpen = false;
		rerender(<BuilderContentArea isCentered={false} isExistingApp={true} />);
		await waitFor(() => {
			expect(screen.queryByTestId("structure-sidebar")).toBeNull();
			expect(
				screen.getByRole("button", { name: "Expand structure sidebar" }),
			).toBeTruthy();
		});
		// Base UI releases the drawer's scroll lock on the next macrotask.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
});
