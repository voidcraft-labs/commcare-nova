/**
 * The corpus's seeded entropy: inside an export operation every generator
 * Nova's exports draw from answers from that operation's own seeded stream;
 * outside one, entropy is real.
 *
 * Contract (`../entropy.mts`): an operation's draws are a function of the
 * corpus seed, its ordinal and its configuration alone, through every
 * entry point Nova reaches (`lib/commcare/ids.ts` over `randomBytes`, the
 * compiler's `randomUUID`, `lib/doc`'s `crypto.randomUUID`, and the
 * `getRandomValues` and `randomFillSync` other modules use), and through
 * their callback forms. The plausible failures: one generator shared by
 * operations that interleave across awaits, so a draw's value depends on
 * scheduling; an entry point left unpatched, so its draws stay random; a
 * patched entry point that writes outside the range it was asked to fill or
 * accepts what Node refuses; seeding that leaks outside an operation, so
 * draws the corpus never asked to seed repeat; two exports sharing an
 * ordinal, so an id one mints names another's entity; and a census
 * (`PROOF_ENTROPY_TRACE`) that cannot say where a read came from when the
 * code on the stack lowered `Error.stackTraceLimit`.
 */

import { execFile } from "node:child_process";
import {
	getRandomValues,
	randomBytes,
	randomFill,
	randomFillSync,
	randomInt,
	randomUUID,
} from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { genHexId, genShortId } from "@/lib/commcare/ids";
import { ENTROPY_PRELOAD, emissionEnv } from "../emissionProcess";
import {
	type EntropyOperation,
	entropySeeded,
	LOCAL_CONFIGURATION,
	OPERATION_ORDINALS,
	seeded,
} from "../entropy.mts";

const CREATE: EntropyOperation = {
	seed: 20260930,
	ordinal: OPERATION_ORDINALS.create,
	configuration: "minimum",
};

/** One draw from every entry point Nova's exports reach. */
function drawEach(): string[] {
	const filled = new Uint8Array(6);
	randomFillSync(filled);
	return [
		genHexId(),
		genShortId(),
		randomUUID(),
		globalThis.crypto.randomUUID(),
		Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).toString(
			"hex",
		),
		Buffer.from(getRandomValues(new Uint8Array(8))).toString("hex"),
		Buffer.from(filled).toString("hex"),
		randomBytes(5).toString("hex"),
		String(randomInt(0, 2 ** 40)),
	];
}

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("seeded entropy", () => {
	it("is installed in every process that imports it", () => {
		expect(entropySeeded()).toBe(true);
	});

	it("answers an operation's draws from its seed, ordinal and configuration alone", () => {
		const first = seeded(CREATE, drawEach);
		expect(seeded(CREATE, drawEach)).toEqual(first);
		expect(first[2]).toMatch(UUID_V4);
		expect(first[3]).toMatch(UUID_V4);
		for (const other of [
			{ ...CREATE, ordinal: OPERATION_ORDINALS.republish },
			{ ...CREATE, configuration: LOCAL_CONFIGURATION },
			{ ...CREATE, seed: CREATE.seed + 1 },
		]) {
			const drawn = seeded(other, drawEach);
			expect(
				drawn.filter((value, at) => value === first[at]),
				JSON.stringify(other),
			).toEqual([]);
		}
		// Every export of a document has a stream of its own.
		const ordinals = Object.values(OPERATION_ORDINALS);
		expect(new Set(ordinals).size).toBe(ordinals.length);
	});

	it("keeps each operation's stream its own while operations interleave across awaits", async () => {
		const alone = seeded(CREATE, () => [genHexId(), genHexId(), genHexId()]);
		const other: EntropyOperation = {
			...CREATE,
			ordinal: OPERATION_ORDINALS.local,
		};
		const otherAlone = seeded(other, () => [genHexId(), genHexId()]);
		const yieldTurn = () =>
			new Promise<void>((resolve) => setImmediate(resolve));
		const [interleaved, otherInterleaved] = await Promise.all([
			seeded(CREATE, async () => {
				const drawn = [genHexId()];
				await yieldTurn();
				drawn.push(genHexId());
				await yieldTurn();
				drawn.push(genHexId());
				return drawn;
			}),
			seeded(other, async () => {
				await yieldTurn();
				const drawn = [genHexId()];
				await yieldTurn();
				drawn.push(genHexId());
				return drawn;
			}),
			// Draws outside any operation, between the operations' own.
			(async () => {
				genHexId();
				await yieldTurn();
				genHexId();
			})(),
		]);
		expect(interleaved).toEqual(alone);
		expect(otherInterleaved).toEqual(otherAlone);
	});

	it("draws real entropy outside an operation", () => {
		const outside = [genHexId(), genHexId(), randomUUID(), randomUUID()];
		expect(new Set(outside).size).toBe(outside.length);
		expect(seeded(undefined, () => genHexId())).not.toBe(
			seeded(undefined, () => genHexId()),
		);
	});

	it("fills only the range it is asked to, and refuses what Node refuses", () => {
		const target = new Uint16Array(6).fill(0xffff);
		seeded(CREATE, () => randomFillSync(target, 2, 3));
		expect([target[0], target[1], target[5]]).toEqual([0xffff, 0xffff, 0xffff]);
		expect([target[2], target[3], target[4]]).not.toEqual([
			0xffff, 0xffff, 0xffff,
		]);
		// The same range, drawn again, is the same.
		const again = new Uint16Array(6).fill(0xffff);
		seeded(CREATE, () => randomFillSync(again, 2, 3));
		expect([...again]).toEqual([...target]);

		const accepted = seeded(CREATE, () =>
			globalThis.crypto.getRandomValues(new Uint32Array(2)),
		);
		expect(accepted).toHaveLength(2);
		expect(() =>
			seeded(CREATE, () =>
				globalThis.crypto.getRandomValues(
					new Float64Array(2) as unknown as Uint32Array,
				),
			),
		).toThrow(/integer|TypeMismatch/i);
		expect(() =>
			seeded(CREATE, () => randomFillSync(new Uint8Array(4), 3, 2)),
		).toThrow(RangeError);

		// randomInt takes a range of at most 2^48 - 1, as Node's does.
		const widest = seeded(CREATE, () => randomInt(0, 2 ** 48 - 1));
		expect(widest).toBe(seeded(CREATE, () => randomInt(0, 2 ** 48 - 1)));
		expect(widest).toBeGreaterThanOrEqual(0);
		expect(widest).toBeLessThan(2 ** 48 - 1);
		for (const [min, max] of [
			[0, 2 ** 48],
			[-1, 2 ** 48 - 1],
			[3, 3],
		] as const) {
			let refusal: unknown;
			try {
				randomInt(min, max);
			} catch (error) {
				refusal = error;
			}
			expect(refusal, `${min}..${max}`).toMatchObject({
				code: "ERR_OUT_OF_RANGE",
			});
			expect(() => seeded(CREATE, () => randomInt(min, max))).toThrow(
				(refusal as Error).message,
			);
		}
	});

	it("answers the callback forms from the operation's stream", async () => {
		const direct = seeded(CREATE, () => [
			randomBytes(7).toString("hex"),
			Buffer.from(randomFillSync(new Uint8Array(4))).toString("hex"),
			String(randomInt(1000)),
		]);
		const fromCallbacks = await seeded(
			CREATE,
			() =>
				new Promise<string[]>((resolve, reject) => {
					randomBytes(7, (error, bytes) => {
						if (error) return reject(error);
						randomFill(new Uint8Array(4), (failure, filled) => {
							if (failure) return reject(failure);
							randomInt(1000, (refused, value) => {
								if (refused) return reject(refused);
								resolve([
									bytes.toString("hex"),
									Buffer.from(filled).toString("hex"),
									String(value),
								]);
							});
						});
					});
				}),
		);
		expect(fromCallbacks).toEqual(direct);
	});

	it("names in its census the code that read the clock, whatever stack limit that code set", {
		// One Node process loading the preload: well under a second.
		timeout: 20_000,
	}, async () => {
		const directory = await mkdtemp(join(tmpdir(), "nova-entropy-trace-"));
		try {
			const script = join(directory, "reads-the-clock.mjs");
			await writeFile(
				script,
				[
					`const { seeded } = await import(${JSON.stringify(ENTROPY_PRELOAD)});`,
					"seeded({ seed: 1, ordinal: 1, configuration: 'minimum' }, () => {",
					"\tError.stackTraceLimit = 0;",
					"\tDate.now();",
					"\tError.stackTraceLimit = 10;",
					"\tDate.now();",
					"});",
					"",
				].join("\n"),
			);
			await promisify(execFile)(
				process.execPath,
				["--import", ENTROPY_PRELOAD, script],
				{ env: emissionEnv({ PROOF_ENTROPY_TRACE: directory }) },
			);
			const [census] = (await readdir(directory)).filter((name) =>
				name.startsWith("entropy-"),
			);
			if (census === undefined) throw new Error("The process wrote no census.");
			const counts: Record<string, number> = JSON.parse(
				await readFile(join(directory, census), "utf8"),
			);
			const clock = Object.entries(counts).filter(([key]) =>
				key.startsWith("scoped Date.now"),
			);
			expect(clock.map(([, count]) => count).reduce((a, b) => a + b, 0)).toBe(
				2,
			);
			for (const [key] of clock) {
				expect(key).toContain("reads-the-clock.mjs");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
