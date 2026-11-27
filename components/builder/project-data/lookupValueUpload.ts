import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { editLookupValueAction } from "@/lib/lookup/largeValues/actions";
import {
	type LookupValueEditRequest,
	VALUE_CHUNK_BYTES,
} from "@/lib/lookup/largeValues/input";

type Begin = Omit<
	Extract<LookupValueEditRequest, { kind: "begin" }>,
	"replacementDigest" | "replacementBytes"
>;
export async function uploadLookupValue(
	projectId: string,
	begin: Begin,
	source: Blob,
	signal: AbortSignal,
	onProgress: (offset: number) => void,
) {
	const digest = sha256.create();
	for (let offset = 0; offset < source.size; offset += VALUE_CHUNK_BYTES) {
		signal.throwIfAborted();
		digest.update(
			new Uint8Array(
				await source.slice(offset, offset + VALUE_CHUNK_BYTES).arrayBuffer(),
			),
		);
	}
	signal.throwIfAborted();
	let answer = await editLookupValueAction(projectId, {
		...begin,
		replacementDigest: bytesToHex(digest.digest()),
		replacementBytes: source.size,
	});
	signal.throwIfAborted();
	if (!answer.ok || answer.state === "complete") return answer;
	if (answer.state !== "staging") throw new Error("This upload was cancelled.");
	let next = answer.nextOffset;
	while (next < source.size) {
		signal.throwIfAborted();
		const bytes = new Uint8Array(
			await source.slice(next, next + VALUE_CHUNK_BYTES).arrayBuffer(),
		);
		const base64 = btoa(String.fromCharCode(...bytes));
		answer = await editLookupValueAction(projectId, {
			kind: "append",
			operationId: begin.operationId,
			tableId: begin.tableId,
			offset: next,
			base64,
		});
		signal.throwIfAborted();
		if (!answer.ok || answer.state === "complete") return answer;
		if (answer.state !== "staging" || answer.nextOffset !== next + bytes.length)
			throw new Error("This upload changed. You can resume it.");
		next = answer.nextOffset;
		onProgress(next);
	}
	signal.throwIfAborted();
	return editLookupValueAction(projectId, {
		kind: "finish",
		tableId: begin.tableId,
		operationId: begin.operationId,
	});
}
