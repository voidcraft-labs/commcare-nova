import { describe, expect, it } from "vitest";
import type { AppBlueprint } from "../../schemas/blueprint";
import { HistoryManager } from "../historyManager";
import { MutableBlueprint } from "../mutableBlueprint";
import { qpath } from "../questionPath";

/**
 * Minimal view context for tests — mirrors the shape used by Builder's
 * ViewContext but kept as a plain object since HistoryManager is generic.
 */
interface TestView {
	label: string;
}

function makeBlueprint(): AppBlueprint {
	return {
		app_name: "Test App",
		modules: [
			{
				name: "Module",
				forms: [
					{
						name: "Form",
						type: "registration",
						questions: [
							{ id: "q1", type: "text", label: "Q1" },
							{ id: "q2", type: "text", label: "Q2" },
							{ id: "q3", type: "text", label: "Q3" },
						],
					},
				],
			},
		],
		case_types: [],
	};
}

/**
 * Helper — creates a HistoryManager with a mutable view label.
 * The returned `setLabel` function updates what `deriveView()` returns,
 * simulating the way Builder.setCursorMode/setScreen update the live state
 * that deriveViewContext() reads at snapshot time.
 */
function createHm(mb: MutableBlueprint, label = "default", maxDepth = 50) {
	let currentLabel = label;
	const hm = new HistoryManager<TestView>(
		mb,
		() => ({ label: currentLabel }),
		maxDepth,
	);
	const setLabel = (l: string) => {
		currentLabel = l;
	};
	return { hm, setLabel };
}

describe("HistoryManager", () => {
	it("starts with empty stacks", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		expect(hm.canUndo).toBe(false);
		expect(hm.canRedo).toBe(false);
	});

	it("captures snapshot on mutation via proxy", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		expect(hm.canUndo).toBe(true);
	});

	it("undo restores previous state and returns view context", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm, setLabel } = createHm(mb);
		setLabel("before-edit");
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("Changed");

		const result = hm.undo();
		expect(result).toBeDefined();
		expect(result?.mb).toBeInstanceOf(MutableBlueprint);
		/* Restored view is the one captured at snapshot time ("before-edit"),
		 * not the current view at undo time. */
		expect(result?.view).toEqual({ label: "before-edit" });
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("Q1");
	});

	it("redo restores undone state and returns view context", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		hm.undo();
		expect(hm.canRedo).toBe(true);

		const result = hm.redo();
		expect(result).toBeDefined();
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("Changed");
	});

	it("new mutation clears redo stack", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "First" });
		hm.undo();
		expect(hm.canRedo).toBe(true);

		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Second" });
		expect(hm.canRedo).toBe(false);
	});

	it("undo returns undefined when stack is empty", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		expect(hm.undo()).toBeUndefined();
	});

	it("redo returns undefined when stack is empty", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		expect(hm.redo()).toBeUndefined();
	});

	it("respects maxDepth", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb, "default", 3);

		for (let i = 0; i < 5; i++) {
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: `Change ${i}` });
		}

		// Should only be able to undo 3 times
		let undoCount = 0;
		while (hm.canUndo) {
			hm.undo();
			undoCount++;
		}
		expect(undoCount).toBe(3);
	});

	it("does not snapshot when disabled", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		hm.enabled = false;
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		expect(hm.canUndo).toBe(false);
	});

	it("clear empties both stacks", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		hm.undo();
		expect(hm.canRedo).toBe(true);

		hm.clear();
		expect(hm.canUndo).toBe(false);
		expect(hm.canRedo).toBe(false);
	});

	it("read methods pass through without snapshot", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);
		// These should not create undo entries
		hm.proxied.getBlueprint();
		hm.proxied.getModule(0);
		hm.proxied.getForm(0, 0);
		hm.proxied.getQuestion(0, 0, qpath("q1"));
		hm.proxied.search("q1");
		expect(hm.canUndo).toBe(false);
	});

	it("multiple undo/redo cycles work correctly", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const { hm } = createHm(mb);

		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "A" });
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "B" });
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "C" });

		hm.undo(); // C → B
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("B");
		hm.undo(); // B → A
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("A");
		hm.redo(); // A → B
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("B");
		hm.redo(); // B → C
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("C");
	});

	// ── View context capture tests ──────────────────────────────────────

	describe("view context capture", () => {
		it("captures current view in snapshot and returns it on undo", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const { hm, setLabel } = createHm(mb);
			setLabel("inspect-mode");
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.view).toEqual({ label: "inspect-mode" });
		});

		it("returns the snapshot's view, not the current view, on undo", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const { hm, setLabel } = createHm(mb);
			setLabel("view-at-edit-1");
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "First" });
			setLabel("view-at-edit-2");
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Second" });

			// Undo edit 2 → returns view captured before edit 2
			const r1 = hm.undo();
			if (!r1) throw new Error("expected undo result");
			expect(r1.view).toEqual({ label: "view-at-edit-2" });
			// Undo edit 1 → returns view captured before edit 1
			const r2 = hm.undo();
			if (!r2) throw new Error("expected undo result");
			expect(r2.view).toEqual({ label: "view-at-edit-1" });
		});

		it("captures current view on redo stack when undoing", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const { hm, setLabel } = createHm(mb);
			setLabel("at-edit");
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });

			/* Switch view then undo — redo entry captures deriveView() at undo time */
			setLabel("at-undo-time");
			hm.undo();

			const result = hm.redo();
			if (!result) throw new Error("expected redo result");
			expect(result.view).toEqual({ label: "at-undo-time" });
		});

		it("preserves view through full undo/redo round trip", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const { hm, setLabel } = createHm(mb);

			setLabel("form-screen");
			hm.proxied.addQuestion(0, 0, { id: "q4", type: "text", label: "Q4" });

			setLabel("after-add");
			const undoResult = hm.undo();
			if (!undoResult) throw new Error("expected undo result");
			/* Undo returns the view from before the add */
			expect(undoResult.view).toEqual({ label: "form-screen" });

			setLabel("after-undo");
			const redoResult = hm.redo();
			if (!redoResult) throw new Error("expected redo result");
			/* Redo returns the view from deriveView() at undo time ("after-add"),
			 * not the label set after undo completed ("after-undo"). */
			expect(redoResult.view).toEqual({ label: "after-add" });
		});
	});

	// ── Structural mutation tests (no longer need special metadata) ─────

	describe("structural mutations", () => {
		it("snapshots structural mutations like any other", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const { hm, setLabel } = createHm(mb);
			setLabel("at-rename");
			hm.proxied.updateModule(0, { name: "Renamed Module" });

			expect(hm.canUndo).toBe(true);
			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			/* View context restored — no navigateToHome bug */
			expect(result.view).toEqual({ label: "at-rename" });
			expect(result.mb.getModule(0)?.name).toBe("Module");
		});

		it("snapshots add/remove question without special metadata", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const { hm, setLabel } = createHm(mb);

			setLabel("before-add");
			hm.proxied.addQuestion(0, 0, { id: "q4", type: "text", label: "Q4" });
			expect(hm.proxied.getQuestion(0, 0, qpath("q4"))?.label).toBe("Q4");

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			/* Question removed, view restored to before-add (no home bounce) */
			expect(result.view).toEqual({ label: "before-add" });
			expect(hm.proxied.getQuestion(0, 0, qpath("q4"))).toBeUndefined();
		});
	});
});
