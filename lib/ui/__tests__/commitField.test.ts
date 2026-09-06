import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommitFieldOptions,
	createCommitFieldModel,
} from "../commitField";

const models: ReturnType<typeof createCommitFieldModel>[] = [];
function editor(overrides: Partial<CommitFieldOptions> = {}) {
	const onSave = vi.fn<CommitFieldOptions["onSave"]>();
	let options: CommitFieldOptions = { value: "original", onSave, ...overrides };
	const model = createCommitFieldModel(() => options);
	models.push(model);
	return {
		model,
		onSave,
		update: (patch: Partial<CommitFieldOptions>) => {
			options = { ...options, ...patch };
		},
	};
}
function type(model: ReturnType<typeof createCommitFieldModel>, draft: string) {
	model.focus();
	model.setDraft(draft);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const model of models.splice(0)) model.dispose();
	vi.useRealTimers();
});

describe("inline edit model", () => {
	it("isolates an active draft while reading the latest authoritative value on a fresh edit", () => {
		const { model, update, onSave } = editor();
		type(model, "my draft");
		update({ value: "peer change" });
		expect(model.getSnapshot().draft).toBe("my draft");
		model.cancel();
		expect(onSave).not.toHaveBeenCalled();
		expect(model.getSnapshot().focused).toBe(false);
		model.focus();
		expect(model.getSnapshot().draft).toBe("peer change");
	});

	it.each(["blur", "enter"])(
		"commits trimmed text once through %s",
		(command) => {
			const { model, onSave } = editor();
			type(model, "  changed  ");
			if (command === "blur") model.blur();
			else expect(model.key("Enter")).toBe(true);
			model.blur();
			expect(onSave).toHaveBeenCalledExactlyOnceWith("changed");
			expect(model.getSnapshot()).toMatchObject({
				focused: false,
				saved: true,
			});
		},
	);

	it("leaves ordinary multiline Enter unconsumed and commits on the platform modifier", () => {
		const { model, onSave } = editor({ multiline: true });
		type(model, "first\nsecond");
		expect(model.key("Enter")).toBe(false);
		expect(onSave).not.toHaveBeenCalled();
		expect(model.getSnapshot().focused).toBe(true);
		expect(model.key("Enter", true)).toBe(true);
		expect(onSave).toHaveBeenCalledExactlyOnceWith("first\nsecond");
	});

	it("cancels on Escape, leaves unrelated keys alone, and prevents a trailing blur save", () => {
		const { model, onSave } = editor();
		type(model, "discarded");
		expect(model.key("ArrowDown")).toBe(false);
		expect(model.key("Escape")).toBe(true);
		model.blur();
		expect(onSave).not.toHaveBeenCalled();
		expect(model.getSnapshot()).toMatchObject({ focused: false, saved: false });
	});

	it("does no work for an unchanged trimmed value", () => {
		const validate = vi.fn(() => true);
		const { model, onSave } = editor({ validate });
		type(model, "  original  ");
		model.commit();
		expect(validate).not.toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("validates the trimmed draft before persistence and only marks an accepted save", () => {
		const validate = vi.fn((value: string) => value !== "bad");
		const { model, onSave } = editor({ validate });
		type(model, "  bad  ");
		model.commit();
		expect(validate).toHaveBeenCalledWith("bad");
		expect(onSave).not.toHaveBeenCalled();
		expect(model.getSnapshot().saved).toBe(false);
		type(model, "  good  ");
		model.commit();
		expect(onSave).toHaveBeenCalledExactlyOnceWith("good");
		expect(model.getSnapshot().saved).toBe(true);
	});

	it.each(["commit", "cancel"] as const)(
		"routes an empty %s to its owner",
		(command) => {
			const onEmpty = vi.fn();
			const { model, onSave } = editor({
				value: command === "cancel" ? " " : "original",
				onEmpty,
			});
			type(model, command === "cancel" ? "discarded" : "  ");
			model[command]();
			expect(onEmpty).toHaveBeenCalledOnce();
			expect(onSave).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("refuses a required empty value but permits clearing an optional value", () => {
		const { model, update, onSave } = editor({ required: true });
		type(model, " ");
		model.commit();
		expect(onSave).not.toHaveBeenCalled();
		update({ required: false });
		type(model, " ");
		model.commit();
		expect(onSave).toHaveBeenCalledExactlyOnceWith("");
	});

	it("keeps a refused draft retryable, renews rejection feedback, and clears it on edit or success", () => {
		const { model, onSave } = editor();
		onSave.mockReturnValue({
			ok: false,
			messages: ["Conflict", "More detail"],
		});
		type(model, "my draft");
		model.commit();
		model.commit();
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(model.getSnapshot()).toMatchObject({
			draft: "my draft",
			focused: true,
			rejection: "Conflict",
			rejectionNonce: 2,
			saved: false,
		});
		model.setDraft("resolved");
		expect(model.getSnapshot().rejection).toBeNull();
		onSave.mockReturnValue(undefined);
		model.commit();
		expect(onSave).toHaveBeenLastCalledWith("resolved");
		expect(model.getSnapshot()).toMatchObject({
			rejection: null,
			focused: false,
			saved: true,
		});
	});

	it("clears a refused draft on cancellation and keeps a messageless refusal quiet", () => {
		const { model, onSave } = editor();
		onSave.mockReturnValue({ ok: false, messages: ["Conflict"] });
		type(model, "bad");
		model.commit();
		model.cancel();
		expect(model.getSnapshot()).toMatchObject({
			focused: false,
			rejection: null,
		});
		onSave.mockReturnValue({ ok: false, messages: [] });
		type(model, "stale");
		model.commit();
		expect(model.getSnapshot()).toMatchObject({
			focused: false,
			rejection: null,
			rejectionNonce: 1,
			saved: false,
		});
	});

	it("keeps saved feedback for 1.5 seconds after the most recent successful commit", () => {
		const { model } = editor();
		type(model, "first");
		model.commit();
		vi.advanceTimersByTime(1000);
		type(model, "second");
		model.commit();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1499);
		expect(model.getSnapshot().saved).toBe(true);
		vi.advanceTimersByTime(1);
		expect(model.getSnapshot().saved).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("owns the feedback timer and subscriptions through disposal", () => {
		const { model } = editor();
		const listener = vi.fn();
		const unsubscribe = model.subscribe(listener);
		try {
			type(model, "changed");
			model.commit();
			expect(listener).toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
		listener.mockClear();
		model.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2000);
		expect(listener).not.toHaveBeenCalled();
	});

	it("does not schedule feedback if persistence disposes the editor synchronously", () => {
		const { model, onSave } = editor();
		onSave.mockImplementation(() => {
			model.dispose();
			return undefined;
		});
		type(model, "changed");
		model.commit();
		expect(onSave).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
