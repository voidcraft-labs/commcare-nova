import type { LookupFixtureRow } from "@/lib/lookup/types";
import { serializeXmlValue } from "../serializeXml";
import { xmlTextIssue } from "../xmlText";
import type { LookupTableWireNaming } from "./naming";
import { type FixtureAtom, workerFixtureAtoms } from "./row";
import {
	LookupRuntimeValueLimit,
	lookupRuntimeStringBytes,
	MAX_LOOKUP_RUNTIME_STRING_BYTES,
} from "./runtimeStrings";

/** The producer scopes every slot to this exact row, table, delivery and
 * generation. Undefined means the stored inline value is authoritative. */
export type FixtureAtomBytes = (
	atom: FixtureAtom,
) => AsyncIterable<Uint8Array> | undefined;

function* escaped(text: string, attribute: boolean): Generator<Uint8Array> {
	for (let start = 0; start < text.length; ) {
		let end = Math.min(text.length, start + 4096);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		const piece = text.slice(start, end);
		const unsupported = xmlTextIssue(piece);
		if (unsupported)
			throw new Error(
				`A value in this table contains the character ${unsupported}, which a device cannot read. You can replace that character and try again.`,
			);
		yield encoder.encode(serializeXmlValue(piece, attribute));
		start = end;
	}
}
const encoder = new TextEncoder();
async function* atomBytes(
	atom: FixtureAtom,
	attribute: boolean,
	read?: FixtureAtomBytes,
	checkRuntime = false,
) {
	let size = 0;
	function encode(part: string) {
		if (checkRuntime) {
			size += lookupRuntimeStringBytes(part);
			if (size > MAX_LOOKUP_RUNTIME_STRING_BYTES)
				throw new LookupRuntimeValueLimit();
		}
		return escaped(part, attribute);
	}
	const bytes = read?.(atom);
	if (!bytes) {
		yield* encode(atom.text);
		return;
	}
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for await (const chunk of bytes) {
		for (let offset = 0; offset < chunk.length; offset += 16384)
			yield* encode(
				decoder.decode(chunk.subarray(offset, offset + 16384), {
					stream: true,
				}),
			);
	}
	yield* encode(decoder.decode());
}
async function* tagAttributes(
	attributes: Iterable<FixtureAtom & { name: string }>,
	read?: FixtureAtomBytes,
	checkRuntime = false,
) {
	for (const item of attributes) {
		yield encoder.encode(` ${item.name}="`);
		yield* atomBytes(item, true, read, checkRuntime);
		yield encoder.encode('"');
	}
}

/** Serialize one already-authorized worker row without buffering a value or
 * the row's output. The surrounding fixture supplies the worker binding. */
export async function* streamWorkerFixtureRow(
	table: LookupTableWireNaming,
	row: LookupFixtureRow,
	read?: FixtureAtomBytes,
	onCell?: () => void,
	checkRuntime = false,
): AsyncGenerator<Uint8Array> {
	const root = workerFixtureAtoms(table, row);
	yield encoder.encode(`<${root.name}`);
	yield* tagAttributes(root.attributes, read, checkRuntime);
	let hasChild = false;
	for (const child of root.children) {
		onCell?.();
		if (!hasChild) {
			yield encoder.encode(">");
			hasChild = true;
		}
		yield encoder.encode(`<${child.name}`);
		yield* tagAttributes(child.attributes, read, checkRuntime);
		let hasText = false;
		for await (const bytes of atomBytes(child, false, read, checkRuntime)) {
			if (!hasText) {
				yield encoder.encode(">");
				hasText = true;
			}
			yield bytes;
		}
		yield encoder.encode(hasText ? `</${child.name}>` : "/>");
	}
	yield encoder.encode(hasChild ? `</${root.name}>` : "/>");
}
