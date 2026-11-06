import { expect, it } from "vitest";
import { __setAppDbForTests } from "../pg";
import { readStreamChunksFrom } from "../streamChunks";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("stream_chunk_read_", { authSchema: "migrated" });

it("reads every cursor position and an empty terminal marker with one database statement", async () => {
	await h.seedApp({ id: "app" });
	await h
		.db()
		.insertInto("chat_stream_chunks")
		.values([
			{
				stream_id: "stream",
				app_id: "app",
				run_id: "run",
				first_index: 0,
				chunks: JSON.stringify(["a", "b", "c"]),
				terminal: false,
			},
			{
				stream_id: "stream",
				app_id: "app",
				run_id: "run",
				first_index: 3,
				chunks: JSON.stringify(["d"]),
				terminal: false,
			},
			{
				stream_id: "stream",
				app_id: "app",
				run_id: "run",
				first_index: 4,
				chunks: "[]",
				terminal: true,
			},
		])
		.execute();
	let statements = 0;
	__setAppDbForTests(
		h.db().withPlugin({
			transformQuery(args) {
				return args.node;
			},
			async transformResult(args) {
				statements++;
				return args.result;
			},
		}),
	);
	for (const [cursor, chunks, endIndex] of [
		[0, ["a", "b", "c", "d"], 4],
		[2, ["c", "d"], 4],
		[3, ["d"], 4],
		[4, [], 4],
		[7, [], 7],
	] as const) {
		statements = 0;
		expect(await readStreamChunksFrom("stream", cursor)).toEqual({
			chunks,
			endIndex,
			terminal: true,
		});
		expect(statements).toBe(1);
	}
	statements = 0;
	expect(await readStreamChunksFrom("missing", 2)).toEqual({
		chunks: [],
		endIndex: 2,
		terminal: false,
	});
	expect(statements).toBe(1);
});
