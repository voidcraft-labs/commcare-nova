import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BuilderHistoryScope,
	builderNavigationUrl,
	reconcileBuilderHistoryEntry,
	scopedBuilderHistoryState,
} from "../historyPolicy";
import {
	NO_PREVIEW_ENTRY_RECORD,
	type PreviewEntryRecord,
	previewEntryRecordReader,
} from "../previewEntryRecords";
import { builderEntryState, readPreviewHeldMenu } from "../previewHeldMenu";

const active: BuilderHistoryScope = {
	scopeId: "runtime-a",
	appId: "app-a",
	epoch: 2,
};
const state = (scope: BuilderHistoryScope) => ({
	__novaProjectScope: scope,
	__NA: true,
	tree: ["preserved"],
});
const entry = (
	stamp: unknown,
	pathname = "/build/app-a/module-a/cases/case%2Fone",
) => ({ pathname, search: "?lang=es", state: stamp });

describe("Builder history policy", () => {
	it("carries only language lenses on path navigation and honors explicit query replacement", () => {
		const from =
			"https://example.test/build/new?design=recovery&lang=es&lang=fr#old";
		expect(builderNavigationUrl("/build/app-a", from)).toBe(
			"/build/app-a?lang=es&lang=fr",
		);
		expect(builderNavigationUrl("/build/app-a/module?lang=de", from)).toBe(
			"/build/app-a/module?lang=de",
		);
		expect(builderNavigationUrl("/build/app-a?", from)).toBe("/build/app-a");
		expect(builderNavigationUrl("/build/app-a/table%2Fname#row", from)).toBe(
			"/build/app-a/table%2Fname?lang=es&lang=fr#row",
		);
		expect(
			builderNavigationUrl(
				"/build/app-a",
				"https://example.test/build/new?design=recovery",
			),
		).toBe("/build/app-a");
	});

	it("preserves a fresh direct case link and claims only its runtime metadata", () => {
		const old = state({ ...active, scopeId: "previous-mount", epoch: 8 });
		const before = entry(old);
		expect(reconcileBuilderHistoryEntry(before, active, "activate")).toEqual({
			url: `${before.pathname}?lang=es`,
			state: state(active),
		});
		expect(before.state).toEqual(old);
		expect(
			reconcileBuilderHistoryEntry(entry(null), active, "activate"),
		).toEqual({
			url: `${before.pathname}?lang=es`,
			state: { __novaProjectScope: active },
		});
	});

	it.each(["activate", "pop"] as const)(
		"scrubs a prior generation's case link during %s while retaining its language and Next state",
		(event) => {
			const before = entry(state({ ...active, epoch: 1 }));
			expect(reconcileBuilderHistoryEntry(before, active, event)).toEqual({
				url: "/build/app-a/module-a/results?lang=es",
				state: state(active),
			});
			expect(before.pathname).toBe("/build/app-a/module-a/cases/case%2Fone");
			expect(before.state).toEqual(state({ ...active, epoch: 1 }));
			const projected = entry(state(active), "/build/app-a/module-a/results");
			expect(
				reconcileBuilderHistoryEntry(projected, active, "pop"),
			).toBeUndefined();
		},
	);

	it("drops a prior generation's entry id, so the session's record of it, held form menu included, is not read, and keeps a current one", () => {
		const held = {
			moduleUuid: testUuid("menu"),
			cases: [{ caseId: "ana" }],
		};
		const list = "/build/app-a/module-a/results";
		const records = new Map<string, PreviewEntryRecord>();
		const reader = previewEntryRecordReader(records);
		/** The menu's entry, pushed after the list's under `scope`, its
		 *  record filed in the session's records. */
		const heldEntry = (scope: typeof active) => {
			const written = builderEntryState(
				{
					pathname: list,
					state: state(scope),
					record: NO_PREVIEW_ENTRY_RECORD,
				},
				{ pathname: list, replace: false, held },
				reader,
			);
			records.set(written.state.__novaEntry as string, written.record);
			return written.state;
		};
		const stale = entry(heldEntry({ ...active, epoch: 1 }), list);
		expect(readPreviewHeldMenu(stale.state, reader)).toEqual(held);
		const reconciled = reconcileBuilderHistoryEntry(stale, active, "pop");
		// The entry it was pushed after goes too: it names another
		// generation's step.
		expect(reconciled?.state).toEqual(state(active));
		expect(readPreviewHeldMenu(reconciled?.state, reader)).toBeUndefined();
		const fresh = entry(
			heldEntry({ ...active, scopeId: "previous-mount" }),
			list,
		);
		expect(
			readPreviewHeldMenu(
				reconcileBuilderHistoryEntry(fresh, active, "activate")?.state,
				reader,
			),
		).toEqual(held);
	});

	it("does not let an outgoing app runtime rewrite another app or a newly mounted runtime", () => {
		for (const other of [
			{ ...active, appId: "app-b" },
			{ ...active, scopeId: "runtime-b" },
		]) {
			const before = entry(state(other), "/build/app-b/module-b/cases/case-b");
			expect(
				reconcileBuilderHistoryEntry(before, active, "pop"),
			).toBeUndefined();
		}
		expect(
			reconcileBuilderHistoryEntry(entry(state(active)), null, "pop"),
		).toBeUndefined();
		expect(scopedBuilderHistoryState(state(active), null)).toEqual(
			state(active),
		);
	});

	it("restamps non-case screens without changing their blueprint identity", () => {
		for (const pathname of [
			"/build/app-a/field-a",
			"/build/app-a/module-a/results",
			"/build/app-a/project-data/table-a",
		]) {
			expect(
				reconcileBuilderHistoryEntry(
					entry(state({ ...active, epoch: 1 }), pathname),
					active,
					"pop",
				),
			).toEqual({ url: `${pathname}?lang=es`, state: state(active) });
		}
	});

	it("does not interpret malformed metadata as a stale generation", () => {
		for (const stamp of [
			null,
			"runtime-a",
			{ scopeId: 1, appId: "app-a", epoch: 1 },
			{ scopeId: "runtime-a", appId: 1, epoch: 1 },
			{ scopeId: "runtime-a", appId: "app-a", epoch: "1" },
		]) {
			const before = entry({ __novaProjectScope: stamp });
			expect(
				reconcileBuilderHistoryEntry(before, active, "pop"),
			).toBeUndefined();
			expect(reconcileBuilderHistoryEntry(before, active, "activate")).toEqual({
				url: `${before.pathname}?lang=es`,
				state: { __novaProjectScope: active },
			});
		}
	});
});
