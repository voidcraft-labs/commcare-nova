import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { LocationProperty } from "@/lib/domain";
import type { OrganizationResult } from "@/lib/organization/actions";
import {
	createOrganizationClient,
	type OrganizationActions,
} from "@/lib/organization/organizationClient";
import type { StoredLocation } from "@/lib/organization/types";
import { createPlaceDraft } from "../placeDraft";

const facility = testUuid("draft-facility");
const warehouse = testUuid("draft-warehouse");
const note = testUuid("draft-note");
const phone = testUuid("draft-phone");
const properties: readonly LocationProperty[] = [
	{ uuid: note, slug: "note", label: "Note" },
	{ uuid: phone, slug: "phone", label: "Phone" },
];
const place: StoredLocation = {
	id: testUuid("draft-place"),
	levelUuid: facility,
	parentId: null,
	siteCode: "clinic",
	name: "Clinic",
	externalId: "old-id",
	latitude: "1",
	longitude: "2",
	values: { [note]: "Stored note", [phone]: "Stored phone" },
	archivedAt: null,
	orderKey: "a0",
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
type Receipt = Awaited<ReturnType<OrganizationActions["update"]>>;
const ok = <T>(data: T): OrganizationResult<T> => ({ success: true, data });
async function harness(initial = place, catalog = properties) {
	const started = Array.from({ length: 8 }, () => deferred<void>());
	const replies = Array.from({ length: 8 }, () => deferred<Receipt>());
	let index = 0;
	const update = vi.fn<OrganizationActions["update"]>(() => {
		const current = index++;
		started[current]?.resolve();
		const reply = replies[current];
		if (reply === undefined) throw new Error("Unexpected extra write");
		return reply.promise;
	});
	const read = vi
		.fn<OrganizationActions["read"]>()
		.mockResolvedValue(ok({ revision: "1", locations: [initial] }));
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected action");
	};
	const actions: OrganizationActions = {
		read,
		update,
		move: update,
		create: unexpected,
		describeArchive: unexpected,
		setArchived: unexpected,
	};
	const client = createOrganizationClient("app", actions, () => async () => ({
		kind: "saved",
	}));
	await client.refresh();
	const editor = createPlaceDraft(initial, catalog, () => client.writer);
	return {
		editor,
		update,
		client,
		read,
		started: (index: number) => started[index]?.promise,
		async settle(
			index: number,
			saved: StoredLocation,
			pending: Promise<void>,
			readRow = saved,
		) {
			read.mockResolvedValue(
				ok({ revision: String(index + 2), locations: [readRow] }),
			);
			replies[index]?.resolve(
				ok({ revision: String(index + 2), location: saved }),
			);
			await pending;
			editor.receive(readRow, catalog);
		},
		async refuse(index: number, pending: Promise<void>) {
			replies[index]?.resolve({
				success: false,
				code: "invalid",
				message: "That placement is no longer available.",
			});
			await pending;
		},
	};
}

describe("place draft through the production organization queue", () => {
	it.each(["name", "externalId", "latitude", "longitude"] as const)(
		"preserves newer %s text through an accepted response and adopts server normalization on the next save",
		async (key) => {
			const { editor, update, started, settle } = await harness();
			editor.editScalar(key, " 3 ");
			const first = editor.saveScalar(key);
			await started(0);
			editor.editScalar(key, " 4 ");
			const saved = { ...place, [key]: "3" };
			await settle(0, saved, first);
			expect(editor.getSnapshot()).toMatchObject({
				source: saved,
				draft: { [key]: " 4 " },
				protected: true,
				peerChanged: false,
				pendingWrites: 0,
			});
			const second = editor.saveScalar(key);
			await started(1);
			const latest = { ...place, [key]: "4" };
			await settle(1, latest, second);
			expect(editor.getSnapshot()).toMatchObject({
				source: latest,
				draft: { [key]: "4" },
				protected: false,
				peerChanged: false,
				pendingWrites: 0,
			});
			expect(update.mock.calls).toEqual([
				["app", place.id, { [key]: " 3 " }, "1"],
				["app", place.id, { [key]: " 4 " }, "2"],
			]);
		},
	);

	it("leaves untouched scalars unsaved, but queues a revert behind a pending scalar save", async () => {
		const { editor, update, started, settle } = await harness();
		await editor.saveScalar("name");
		expect(update).not.toHaveBeenCalled();
		editor.editScalar("name", "Renamed");
		const first = editor.saveScalar("name");
		await started(0);
		editor.editScalar("name", "Clinic");
		const second = editor.saveScalar("name");
		expect(update).toHaveBeenCalledTimes(1);
		expect(editor.getSnapshot().pendingWrites).toBe(2);
		await settle(0, { ...place, name: "Renamed" }, first);
		await started(1);
		expect(editor.getSnapshot().draft.name).toBe("Clinic");
		await settle(1, place, second);
		expect(update.mock.calls).toEqual([
			["app", place.id, { name: "Renamed" }, "1"],
			["app", place.id, { name: "Clinic" }, "2"],
		]);
		expect(editor.getSnapshot()).toMatchObject({
			protected: false,
			peerChanged: false,
			pendingWrites: 0,
		});
	});

	it.each(["externalId", "latitude", "longitude"] as const)(
		"sends a blank %s as absence",
		async (key) => {
			const { editor, update, started, settle } = await harness();
			editor.editScalar(key, "");
			const pending = editor.saveScalar(key);
			await started(0);
			await settle(0, { ...place, [key]: null }, pending);
			expect(update.mock.calls[0]).toEqual([
				"app",
				place.id,
				{ [key]: null },
				"1",
			]);
			expect(editor.getSnapshot()).toMatchObject({
				draft: { [key]: "" },
				protected: false,
			});
		},
	);

	it("keeps only authored fields over a peer snapshot and pauses writes until that explicit choice", async () => {
		const { editor, update } = await harness();
		editor.editScalar("name", "Local name");
		editor.editValue(note, "Local note");
		const peer = {
			...place,
			externalId: "peer-id",
			latitude: "3",
			values: { [note]: "Peer note", [phone]: "Peer phone" },
		};
		editor.receive(peer, properties);
		expect(editor.getSnapshot()).toMatchObject({
			peerChanged: true,
			protected: true,
			draft: { name: "Local name", externalId: "old-id" },
		});
		await editor.saveScalar("name");
		expect(update).not.toHaveBeenCalled();
		expect(editor.getSnapshot().message).toBe(
			"This place changed while you were editing. Use the latest saved values before saving your draft.",
		);
		editor.keepDraft();
		expect(editor.getSnapshot()).toEqual({
			source: peer,
			draft: {
				name: "Local name",
				externalId: "peer-id",
				latitude: "3",
				longitude: "2",
				levelUuid: facility,
				parentId: null,
				values: { [note]: "Local note", [phone]: "Peer phone" },
			},
			dirtyLevel: false,
			dirtyPlacement: false,
			protected: true,
			peerChanged: false,
			pendingWrites: 0,
			valuesNeedApply: true,
			hiddenDirtyPropertyUuids: [],
			message: undefined,
		});
	});

	it.each(["adopt", "keep", "unresolved"] as const)(
		"an older accepted row cannot undo %s peer recovery",
		async (choice) => {
			const { editor, started, settle } = await harness();
			editor.editScalar("name", "Older local save");
			const pending = editor.saveScalar("name");
			await started(0);
			const peer = { ...place, name: "Peer name", externalId: "peer-id" };
			editor.receive(peer, properties);
			editor.editScalar("name", "Newer local draft");
			if (choice === "adopt") editor.adoptLatest();
			if (choice === "keep") editor.keepDraft();
			await settle(0, { ...place, name: "Older local save" }, pending, peer);
			expect(editor.getSnapshot()).toMatchObject({
				draft: { name: choice === "adopt" ? "Peer name" : "Newer local draft" },
				peerChanged: choice === "unresolved",
				protected: choice !== "adopt",
				pendingWrites: 0,
			});
		},
	);

	it("rebases a custom-value receipt without erasing another field still being typed", async () => {
		const { editor, update, started, settle } = await harness();
		editor.editValue(note, "New note");
		const pending = editor.saveValue(note, "New note");
		await started(0);
		editor.editValue(phone, "New phone");
		const saved = { ...place, values: { ...place.values, [note]: "New note" } };
		await settle(0, saved, pending);
		expect(editor.getSnapshot()).toMatchObject({
			draft: { values: { [note]: "New note", [phone]: "New phone" } },
			protected: true,
			peerChanged: false,
			valuesNeedApply: true,
		});
		const second = editor.saveValue(phone, "New phone");
		await started(1);
		await settle(
			1,
			{ ...saved, values: { ...saved.values, [phone]: "New phone" } },
			second,
		);
		expect(editor.getSnapshot().protected).toBe(false);
		expect(update.mock.calls).toEqual([
			["app", place.id, { valuePatch: { [note]: "New note" } }, "1"],
			["app", place.id, { valuePatch: { [phone]: "New phone" } }, "2"],
		]);
	});

	it("clears one custom value without replacing its sibling bag", async () => {
		const { editor, update, started, settle } = await harness();
		const pending = editor.saveValue(note, "");
		await started(0);
		await settle(0, { ...place, values: { [phone]: "Stored phone" } }, pending);
		expect(update.mock.calls[0]).toEqual([
			"app",
			place.id,
			{ valuePatch: { [note]: null } },
			"1",
		]);
		expect(editor.getSnapshot()).toMatchObject({
			draft: { values: { [phone]: "Stored phone" } },
			protected: false,
		});
	});

	it("finishes a value save before its queued retype while preserving the new level's draft", async () => {
		const { editor, update, started, settle } = await harness();
		const valueSave = editor.saveValue(note, "Facility note");
		await started(0);
		editor.stageLevel(warehouse, null);
		editor.editValue(note, "Warehouse note");
		await editor.saveValue(note, "Warehouse note");
		const retype = editor.applyPlacement();
		expect(update).toHaveBeenCalledTimes(1);
		const valueRow = {
			...place,
			values: { ...place.values, [note]: "Facility note" },
		};
		await settle(0, valueRow, valueSave);
		await started(1);
		expect(editor.getSnapshot()).toMatchObject({
			draft: { levelUuid: warehouse, values: { [note]: "Warehouse note" } },
			peerChanged: false,
			protected: true,
		});
		const saved = {
			...place,
			levelUuid: warehouse,
			values: { ...place.values, [note]: "Warehouse note" },
		};
		await settle(1, saved, retype);
		expect(editor.getSnapshot()).toMatchObject({
			source: saved,
			protected: false,
			valuesNeedApply: false,
			peerChanged: false,
		});
		expect(update.mock.calls[1]).toEqual([
			"app",
			place.id,
			{ levelUuid: warehouse, parentId: null, values: saved.values },
			"2",
		]);
	});

	it("keeps a newer level choice when an earlier placement returns", async () => {
		const { editor, started, settle } = await harness();
		editor.stageLevel(warehouse, null);
		const pending = editor.applyPlacement();
		await started(0);
		editor.stageLevel(facility, null);
		await settle(0, { ...place, levelUuid: warehouse }, pending);
		expect(editor.getSnapshot()).toMatchObject({
			draft: { levelUuid: facility },
			dirtyLevel: true,
			dirtyPlacement: true,
			protected: true,
			peerChanged: false,
		});
		const retry = editor.applyPlacement();
		await started(1);
		await settle(1, place, retry);
		expect(editor.getSnapshot().protected).toBe(false);
	});

	it("leaves new custom text available for a second apply after a placement receipt", async () => {
		const { editor, started, settle } = await harness();
		editor.stageLevel(warehouse, null);
		const pending = editor.applyPlacement();
		await started(0);
		editor.editValue(note, "Authored during save");
		await editor.saveValue(note, "Authored during save");
		const saved = { ...place, levelUuid: warehouse };
		await settle(0, saved, pending);
		expect(editor.getSnapshot()).toMatchObject({
			draft: { values: { [note]: "Authored during save" } },
			valuesNeedApply: true,
			protected: true,
			dirtyPlacement: false,
		});
		const second = editor.applyPlacement();
		await started(1);
		await settle(
			1,
			{ ...saved, values: { ...saved.values, [note]: "Authored during save" } },
			second,
		);
		expect(editor.getSnapshot()).toMatchObject({
			protected: false,
			valuesNeedApply: false,
		});
	});

	it("retains a refused parent draft for retry and reports the actual writer refusal", async () => {
		const { editor, started, settle, refuse, update } = await harness();
		const parentId = testUuid("draft-parent");
		editor.stageParent(parentId);
		const first = editor.applyPlacement();
		await started(0);
		await refuse(0, first);
		expect(editor.getSnapshot()).toMatchObject({
			draft: { parentId },
			dirtyPlacement: true,
			protected: true,
			message: "That placement is no longer available.",
		});
		const second = editor.applyPlacement();
		await started(1);
		await settle(1, { ...place, parentId }, second);
		expect(editor.getSnapshot()).toMatchObject({
			protected: false,
			dirtyPlacement: false,
			message: undefined,
		});
		expect(update.mock.calls[1]?.[2]).toEqual(update.mock.calls[0]?.[2]);
	});

	it("keeps unavailable dirty values recoverable until the author discards them", async () => {
		const { editor, update } = await harness();
		editor.editValue(note, "Unsaved note");
		editor.receive(
			place,
			properties.filter((property) => property.uuid !== note),
		);
		expect(editor.getSnapshot()).toMatchObject({
			hiddenDirtyPropertyUuids: [note],
			protected: true,
		});
		editor.discardHiddenValues();
		expect(editor.getSnapshot()).toMatchObject({
			hiddenDirtyPropertyUuids: [],
			protected: false,
			draft: { values: { [phone]: "Stored phone" } },
		});
		expect(update).not.toHaveBeenCalled();
	});
	it("keeps a changed scoped value bag explicit when the author returns to the original level", async () => {
		const scoped = properties.map((property) =>
			property.uuid === note
				? { ...property, levelUuids: [facility] }
				: property,
		);
		const { editor, started, settle, update } = await harness(place, scoped);
		editor.stageLevel(warehouse, null);
		editor.stageLevel(facility, null);
		expect(editor.getSnapshot()).toMatchObject({
			dirtyPlacement: false,
			valuesNeedApply: true,
			protected: true,
			draft: { values: { [phone]: "Stored phone" } },
		});
		const pending = editor.applyPlacement();
		await started(0);
		await settle(0, { ...place, values: { [phone]: "Stored phone" } }, pending);
		expect(update.mock.calls[0]?.[2]).toEqual({
			levelUuid: facility,
			parentId: null,
			values: { [phone]: "Stored phone" },
		});
		expect(editor.getSnapshot()).toMatchObject({
			protected: false,
			valuesNeedApply: false,
		});
	});

	it("adopts catalog removal without creating a draft when none was authored", async () => {
		const { editor } = await harness();
		editor.receive(
			place,
			properties.filter((property) => property.uuid !== note),
		);
		expect(editor.getSnapshot()).toMatchObject({
			protected: false,
			hiddenDirtyPropertyUuids: [],
			draft: { values: { [phone]: "Stored phone" } },
		});
	});
});
