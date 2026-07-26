/**
 * What a submission carries as its attachment set.
 *
 * `collectAttachmentNames` decides which staged attachments survive a
 * submission. The server promotes that exact set; omitted staged rows remain
 * retryable/expirable rather than being destructively classified.
 *
 * The two behaviors most worth pinning are the ones that differ from the
 * real runtime. It enumerates the session's media DIRECTORY rather than the
 * answers (`FormSubmissionHelper::getMultiPartFormBody`), so a deleted
 * repeat instance's file and a hidden question's file both still upload,
 * still consume one of the 50 attachment slots, and land in HQ referenced by
 * nothing. Nova keeps only what the submission actually names.
 */

import { describe, expect, it } from "vitest";
import type { Field, Form, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { FormEngine, type FormEngineInput } from "../formEngine";

type Spec = {
	id: string;
	kind: Field["kind"];
	label?: string;
	relevant?: string;
	repeat_mode?: string;
	children?: Spec[];
};

/** Build a `FormEngineInput` from a nested spec, mirroring `dTree`. */
function input(fields: Spec[]): FormEngineInput {
	const formUuid = asUuid("form");
	const form: Form = {
		uuid: formUuid,
		id: "f",
		name: "F",
		type: "survey",
	};
	const fieldMap: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const walk = (nodes: Spec[], parentUuid: Uuid, prefix: string) => {
		const order: Uuid[] = [];
		for (const node of nodes) {
			const uuid = asUuid(`${prefix}.${node.id}`);
			order.push(uuid);
			const { children, ...rest } = node;
			// `relevant` rides through as a plain string: the engine reads
			// expression slots via `expressionSource`, which passes a legacy
			// string straight through, and that is what the sibling engine
			// fixtures use.
			fieldMap[uuid as string] = { uuid, ...rest } as unknown as Field;
			if (children) walk(children, uuid, `${prefix}.${node.id}`);
		}
		fieldOrder[parentUuid as string] = order;
	};
	walk(fields, formUuid, "form");
	return { form, formUuid, fields: fieldMap, fieldOrder };
}

describe("collectAttachmentNames", () => {
	it("returns nothing when no capture has an answer", () => {
		const engine = new FormEngine(
			input([{ id: "photo", kind: "image", label: "Photo" }]),
		);
		expect(engine.collectAttachmentNames()).toEqual([]);
	});

	it("collects an answered capture's name", () => {
		const engine = new FormEngine(
			input([{ id: "photo", kind: "image", label: "Photo" }]),
		);
		engine.setValue("/data/photo", "att-1.jpg");
		expect(engine.collectAttachmentNames()).toEqual(["att-1.jpg"]);
	});

	it("ignores non-capture answers", () => {
		// A text answer is a case property, not an attachment name; collecting
		// it would ask the server to promote a row that does not exist.
		const engine = new FormEngine(
			input([
				{ id: "note", kind: "text", label: "Note" },
				{ id: "code", kind: "barcode", label: "Code" },
			]),
		);
		engine.setValue("/data/note", "hello");
		engine.setValue("/data/code", "12345");
		expect(engine.collectAttachmentNames()).toEqual([]);
	});

	it("collects every capture kind", () => {
		const engine = new FormEngine(
			input([
				{ id: "a", kind: "image", label: "A" },
				{ id: "b", kind: "audio", label: "B" },
				{ id: "c", kind: "video", label: "C" },
				{ id: "d", kind: "signature", label: "D" },
				{ id: "e", kind: "file", label: "E" },
			]),
		);
		for (const id of ["a", "b", "c", "d", "e"]) {
			engine.setValue(`/data/${id}`, `${id}.bin`);
		}
		expect(engine.collectAttachmentNames().sort()).toEqual([
			"a.bin",
			"b.bin",
			"c.bin",
			"d.bin",
			"e.bin",
		]);
	});

	it("collects a capture nested in a group", () => {
		const engine = new FormEngine(
			input([
				{
					id: "section",
					kind: "group",
					label: "Section",
					children: [{ id: "photo", kind: "image", label: "Photo" }],
				},
			]),
		);
		engine.setValue("/data/section/photo", "att-1.jpg");
		expect(engine.collectAttachmentNames()).toEqual(["att-1.jpg"]);
	});

	it("DROPS a capture whose question is no longer relevant", () => {
		// The divergence that matters. On the wire the irrelevant question's
		// node is omitted from the submitted instance
		// (`XFormSerializingVisitor::serializeNode` returns null), so its
		// attachment is not part of the submission — yet the real runtime
		// uploads the file anyway. Nova does not.
		const engine = new FormEngine(
			input([
				{ id: "gate", kind: "text", label: "Gate" },
				{
					id: "photo",
					kind: "image",
					label: "Photo",
					relevant: "/data/gate = 'yes'",
				},
			]),
		);
		engine.setValue("/data/gate", "yes");
		engine.setValue("/data/photo", "att-1.jpg");
		expect(engine.collectAttachmentNames()).toEqual(["att-1.jpg"]);

		// Flip the condition: the value survives in the instance (matching the
		// platform, whose session serialization ignores relevance) but the
		// submission no longer names it.
		engine.setValue("/data/gate", "no");
		expect(engine.collectAttachmentNames()).toEqual([]);
	});

	it("collects one name per live repeat iteration", () => {
		const engine = new FormEngine(
			input([
				{
					id: "visits",
					kind: "repeat",
					label: "Visits",
					repeat_mode: "user_controlled",
					children: [{ id: "photo", kind: "image", label: "Photo" }],
				},
			]),
		);
		engine.addRepeat("/data/visits");
		engine.setValue("/data/visits[0]/photo", "first.jpg");
		engine.setValue("/data/visits[1]/photo", "second.jpg");
		expect(engine.collectAttachmentNames().sort()).toEqual([
			"first.jpg",
			"second.jpg",
		]);
	});

	it("DROPS a deleted repeat instance's attachment", () => {
		// The other divergence: `JsonActionUtils::deleteRepeatToJson` touches
		// no media, so on a device the orphan still uploads and still consumes
		// an attachment slot. Here it simply stops being named.
		const engine = new FormEngine(
			input([
				{
					id: "visits",
					kind: "repeat",
					label: "Visits",
					repeat_mode: "user_controlled",
					children: [{ id: "photo", kind: "image", label: "Photo" }],
				},
			]),
		);
		engine.addRepeat("/data/visits");
		engine.setValue("/data/visits[0]/photo", "first.jpg");
		engine.setValue("/data/visits[1]/photo", "second.jpg");
		engine.removeRepeat("/data/visits", 1);
		expect(engine.collectAttachmentNames()).toEqual(["first.jpg"]);
	});
});

describe("the mutation's attachment slots", () => {
	it("carries an EMPTY list when nothing was attached, given an entry key", () => {
		// Empty means "this submission named nothing" and therefore needs no
		// durable capture intent. It must not be confused with absent, which
		// means "a client that knows nothing about attachments".
		const engine = new FormEngine(
			input([{ id: "photo", kind: "image", label: "Photo" }]),
		);
		const mutation = engine.computeSubmissionMutation({
			caseTypes: [],
			entryKey: "entry-1",
		});
		expect(mutation.entryKey).toBe("entry-1");
		expect(mutation.attachmentNames).toEqual([]);
		expect(mutation.attachmentRefs).toEqual([]);
	});

	it("carries exact field/path provenance for a referenced capture", () => {
		const engine = new FormEngine(
			input([{ id: "photo", kind: "image", label: "Photo" }]),
		);
		engine.setValue("/data/photo", "att-1.jpg");
		const mutation = engine.computeSubmissionMutation({
			caseTypes: [],
			entryKey: "entry-1",
		});
		expect(mutation.attachmentRefs).toEqual([
			{
				attachmentName: "att-1.jpg",
				fieldUuid: "form.photo",
				instancePath: "/data/photo",
			},
		]);
	});

	it("omits every attachment slot when no entry key is supplied", () => {
		const engine = new FormEngine(
			input([{ id: "photo", kind: "image", label: "Photo" }]),
		);
		engine.setValue("/data/photo", "att-1.jpg");
		const mutation = engine.computeSubmissionMutation({ caseTypes: [] });
		expect(mutation.entryKey).toBeUndefined();
		expect(mutation.attachmentNames).toBeUndefined();
		expect(mutation.attachmentRefs).toBeUndefined();
	});
});
