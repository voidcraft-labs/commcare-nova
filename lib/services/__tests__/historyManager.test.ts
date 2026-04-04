import { describe, expect, it } from "vitest";
import type { AppBlueprint } from "../../schemas/blueprint";
import { HistoryManager } from "../historyManager";
import { MutableBlueprint } from "../mutableBlueprint";
import { qpath } from "../questionPath";

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

describe("HistoryManager", () => {
	it("starts with empty stacks", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		expect(hm.canUndo).toBe(false);
		expect(hm.canRedo).toBe(false);
	});

	it("captures snapshot on mutation via proxy", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		expect(hm.canUndo).toBe(true);
	});

	it("undo restores previous state and returns meta", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("Changed");

		const result = hm.undo();
		expect(result).toBeDefined();
		expect(result?.mb).toBeInstanceOf(MutableBlueprint);
		expect(result?.meta.type).toBe("update");
		expect(result?.meta.questionPath).toBe(qpath("q1"));
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("Q1");
	});

	it("redo restores undone state and returns meta", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		hm.undo();
		expect(hm.canRedo).toBe(true);

		const result = hm.redo();
		expect(result).toBeDefined();
		expect(result?.meta.type).toBe("update");
		expect(hm.proxied.getQuestion(0, 0, qpath("q1"))?.label).toBe("Changed");
	});

	it("new mutation clears redo stack", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "First" });
		hm.undo();
		expect(hm.canRedo).toBe(true);

		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Second" });
		expect(hm.canRedo).toBe(false);
	});

	it("undo returns undefined when stack is empty", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		expect(hm.undo()).toBeUndefined();
	});

	it("redo returns undefined when stack is empty", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		expect(hm.redo()).toBeUndefined();
	});

	it("respects maxDepth", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb, 3);

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
		const hm = new HistoryManager(mb);
		hm.enabled = false;
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		expect(hm.canUndo).toBe(false);
	});

	it("clear empties both stacks", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
		hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });
		hm.undo();
		expect(hm.canRedo).toBe(true);

		hm.clear();
		expect(hm.canUndo).toBe(false);
		expect(hm.canRedo).toBe(false);
	});

	it("read methods pass through without snapshot", () => {
		const mb = new MutableBlueprint(makeBlueprint());
		const hm = new HistoryManager(mb);
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
		const hm = new HistoryManager(mb);

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

	// ── Cursor mode capture tests ───────────────────────────────────────

	describe("cursorMode capture", () => {
		it("captures current cursorMode in snapshot", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.cursorMode = "inspect";
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.cursorMode).toBe("inspect");
		});

		it("returns cursorMode of the snapshot being restored on undo", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.cursorMode = "inspect";
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "First" });
			hm.cursorMode = "pointer";
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Second" });

			// Undo the pointer edit → returns 'pointer' (where the edit was made)
			const r1 = hm.undo();
			if (!r1) throw new Error("expected undo result");
			expect(r1.cursorMode).toBe("pointer");
			// Undo the inspect edit → returns 'inspect'
			const r2 = hm.undo();
			if (!r2) throw new Error("expected undo result");
			expect(r2.cursorMode).toBe("inspect");
		});

		it("captures current cursorMode on redo stack when undoing", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.cursorMode = "inspect";
			hm.proxied.updateQuestion(0, 0, qpath("q1"), { label: "Changed" });

			// Switch to pointer then undo — redo entry captures 'pointer' (current at undo time)
			hm.cursorMode = "pointer";
			hm.undo();

			const result = hm.redo();
			if (!result) throw new Error("expected redo result");
			expect(result.cursorMode).toBe("pointer");
		});
	});

	// ── Metadata capture tests ───────────────────────────────────────────

	describe("metadata capture", () => {
		it("captures add metadata", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.proxied.addQuestion(0, 0, { id: "q4", type: "text", label: "Q4" });

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.meta).toEqual({
				type: "add",
				moduleIndex: 0,
				formIndex: 0,
				questionPath: qpath("q4"),
			});
		});

		it("captures remove metadata", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.proxied.removeQuestion(0, 0, qpath("q2"));

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.meta).toEqual({
				type: "remove",
				moduleIndex: 0,
				formIndex: 0,
				questionPath: qpath("q2"),
			});
		});

		it("captures move metadata", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.proxied.moveQuestion(0, 0, qpath("q3"), { afterPath: qpath("q1") });

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.meta).toEqual({
				type: "move",
				moduleIndex: 0,
				formIndex: 0,
				questionPath: qpath("q3"),
			});
		});

		it("captures duplicate metadata with clone ID", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			const cloneId = hm.proxied.duplicateQuestion(0, 0, qpath("q1"));

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.meta.type).toBe("duplicate");
			expect(result.meta.questionPath).toBe(qpath("q1"));
			expect(result.meta.secondaryPath).toBe(cloneId);
		});

		it("captures rename metadata", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.proxied.renameQuestion(0, 0, qpath("q1"), "q1_renamed");

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.meta).toEqual({
				type: "rename",
				moduleIndex: 0,
				formIndex: 0,
				questionPath: qpath("q1"),
				secondaryPath: qpath("q1_renamed"),
			});
		});

		it("captures structural metadata for non-question mutations", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.proxied.updateModule(0, { name: "Renamed Module" });

			const result = hm.undo();
			if (!result) throw new Error("expected undo result");
			expect(result.meta.type).toBe("structural");
		});

		it("preserves metadata through redo", () => {
			const mb = new MutableBlueprint(makeBlueprint());
			const hm = new HistoryManager(mb);
			hm.proxied.removeQuestion(0, 0, qpath("q2"));

			hm.undo();
			const result = hm.redo();
			if (!result) throw new Error("expected redo result");
			expect(result.meta.type).toBe("remove");
			expect(result.meta.questionPath).toBe(qpath("q2"));
		});
	});
});
