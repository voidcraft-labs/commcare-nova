/**
 * The structural moment diff: what the model receives here that it did not
 * receive there, by item identity.
 *
 * The failure this prevents is a misleading "what changes" panel: a label
 * edit reported as a content change, a cache-boundary move reported as
 * kept, or a removed item lost from the list.
 */

import { describe, expect, it } from "vitest";
import { diffMoments } from "../diff";
import type { ContextItem, Moment } from "../types";

const SOURCE = { file: "lib/agent/prompts.ts", symbol: "x" };

function system(id: string, text: string, label = "System"): ContextItem {
	return {
		kind: "system",
		id,
		label,
		origin: "composed",
		source: SOURCE,
		text,
		segments: [{ id: "s", title: "S", text, source: SOURCE }],
	};
}

function message(
	id: string,
	text: string,
	options: { cacheBoundary?: boolean; note?: string; label?: string } = {},
): ContextItem {
	return {
		kind: "message",
		id,
		label: options.label ?? id,
		origin: "derived",
		source: SOURCE,
		wireRole: "user",
		message: { role: "user", content: text },
		...(options.cacheBoundary && { cacheBoundary: true }),
		...(options.note && { note: options.note }),
	};
}

function missing(id: string, explanation: string): ContextItem {
	return {
		kind: "missing",
		id,
		label: id,
		origin: "composed",
		source: SOURCE,
		needs: "app",
		explanation,
	};
}

function moment(id: string, items: ContextItem[]): Moment {
	return { id, label: id, why: "", needs: [], source: SOURCE, items };
}

describe("diffMoments", () => {
	it("classifies added, removed, replaced, and kept items by id", () => {
		const baseline = moment("a", [
			system("system", "prompt"),
			message("history:0", "hello"),
			message("app-state", "state v1"),
		]);
		const selected = moment("b", [
			system("system", "prompt"),
			message("history:0", "hello"),
			message("retry", "continue"),
			message("app-state", "state v2"),
		]);
		const diff = diffMoments(baseline, selected);
		expect(diff.entries.map((entry) => [entry.id, entry.status])).toEqual([
			["system", "kept"],
			["history:0", "kept"],
			["retry", "added"],
			["app-state", "replaced"],
		]);
		expect(diff.counts).toEqual({ added: 1, removed: 0, replaced: 1, kept: 2 });
		expect(diff.baseline).toEqual({ id: "a", label: "a" });
		expect(diff.selected).toEqual({ id: "b", label: "b" });
	});

	it("lists selected items in their order, then items only the baseline had", () => {
		const baseline = moment("a", [
			message("one", "1"),
			message("gone", "x"),
			message("two", "2"),
		]);
		const selected = moment("b", [message("two", "2"), message("one", "1")]);
		const diff = diffMoments(baseline, selected);
		expect(diff.entries.map((entry) => entry.id)).toEqual([
			"two",
			"one",
			"gone",
		]);
		expect(diff.entries.at(-1)?.status).toBe("removed");
		expect(diff.counts.removed).toBe(1);
	});

	it("ignores label and note changes when judging content", () => {
		const baseline = moment("a", [
			system("system", "prompt", "System prompt"),
			message("m", "same", { label: "Before", note: "old note" }),
		]);
		const selected = moment("b", [
			system("system", "prompt", "Renamed"),
			message("m", "same", { label: "After", note: "new note" }),
		]);
		const diff = diffMoments(baseline, selected);
		expect(diff.entries.every((entry) => entry.status === "kept")).toBe(true);
		expect(diff.entries[1]?.label).toBe("After");
	});

	it("treats a moved cache boundary as a replaced message", () => {
		const baseline = moment("a", [message("m", "same")]);
		const selected = moment("b", [
			message("m", "same", { cacheBoundary: true }),
		]);
		expect(diffMoments(baseline, selected).entries[0]?.status).toBe("replaced");
	});

	it("treats a missing item whose explanation changed as replaced", () => {
		const baseline = moment("a", [missing("history", "needs an app")]);
		const selected = moment("b", [missing("history", "no thread yet")]);
		expect(diffMoments(baseline, selected).entries[0]?.status).toBe("replaced");
	});

	it("counts sum to the number of entries", () => {
		const baseline = moment("a", [
			message("k", "1"),
			message("r", "old"),
			message("gone", "x"),
		]);
		const selected = moment("b", [
			message("k", "1"),
			message("r", "new"),
			message("new", "y"),
		]);
		const diff = diffMoments(baseline, selected);
		const total = Object.values(diff.counts).reduce((sum, n) => sum + n, 0);
		expect(total).toBe(diff.entries.length);
		expect(diff.counts).toEqual({ added: 1, removed: 1, replaced: 1, kept: 1 });
	});
});
