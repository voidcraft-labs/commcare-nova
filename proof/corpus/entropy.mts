/**
 * Seeded entropy for the corpus's exports, so one emission's bytes are a
 * function of its inputs alone.
 *
 * Every export Nova makes mints identities from `node:crypto`: module and
 * form `unique_id`s and form `xmlns` (`lib/commcare/ids.ts`, `randomBytes`),
 * a `.ccz` profile's `uniqueid` (`lib/commcare/compiler.ts`, `randomUUID`),
 * and `crypto.randomUUID` wherever `lib/doc` mints one. Inside an export
 * operation (`seeded`), this module answers those draws from an HMAC-SHA256
 * DRBG (NIST SP 800-90A, HMAC_DRBG without reseeding) whose seed is
 * sha256(corpus seed, operation ordinal, configuration name). A seeded draw
 * is a draw the real generator could have made, so what an export sends is
 * one Nova could send; it is only reproducible.
 *
 * The seed names no document on purpose: two documents with the same
 * content export the same bytes. The ordinals (`OPERATION_ORDINALS`) keep
 * apart what Nova keeps apart: a document's create and its next publish
 * mint different ids (defect 1 stays visible), and so do its two local
 * exports (defect 9). An update to D′ is drawn at the republish's ordinal
 * first and kept only when it sends exactly the republish of D; otherwise
 * it is drawn again at its own (`./publish.ts::capturePublish`), so the ids
 * it mints are never the ones D's republish minted for another entity.
 *
 * Every emission process loads this module first, before any module that
 * could take a reference to a generator, with `--import`:
 *
 *   node --import ./proof/corpus/entropy.mts ...
 *
 * Node strips its types and, by its `.mts` extension, loads it as an ES
 * module without tsx (the package declares no module type to read); it
 * imports only Node's own modules, so a process started without tsx, as the
 * Vitest writers' workers are (through `NODE_OPTIONS`), loads it too. The corpus
 * code imports it as well, for `seeded`; every copy of the module shares one
 * state on `globalThis`, so the copy the preload installed and the one tsx
 * compiles for the corpus code are one generator. Outside an operation every
 * draw is real entropy.
 *
 * `PROOF_ENTROPY=real` installs nothing: every draw is real, as it is in
 * Nova. The emission runs that way only to show that seeding changes nothing
 * but the minted values.
 *
 * `PROOF_ENTROPY_TRACE=<directory>` also records, per process, every draw
 * (inside an operation or not) and every clock or `Math.random` read inside
 * an operation, by the first stack frame outside this module, in
 * `<directory>/entropy-<pid>.json` when the process exits: the census of
 * what an emission draws, and from where.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

/** One export operation: the corpus seed, which export of a document it is, and its configuration. */
export interface EntropyOperation {
	/** The corpus seed (`emit.ts --seed`). */
	readonly seed: number;
	/** Which export of a document this is (`OPERATION_ORDINALS`). */
	readonly ordinal: number;
	/** The configuration it publishes under (`minimum`, `maximum`, a flag symbol), or `LOCAL_CONFIGURATION`. */
	readonly configuration: string;
}

/**
 * The ordinal of each export of a corpus document. An update to D′ that
 * sends exactly the republish of D is the republish's draw (an edit that
 * changes nothing Nova sends leaves the two byte-identical); any other
 * update to D′ is drawn at `update`, a stream of its own, so none of the ids
 * it mints for one entity is an id the republish minted for another.
 */
export const OPERATION_ORDINALS = {
	create: 1,
	republish: 2,
	local: 3,
	localAgain: 4,
	editLocal: 5,
	update: 6,
} as const;

/** Node's `randomInt` reads 48 bits per attempt, and refuses a range wider than this. */
const RAND_MAX = 0xffff_ffff_ffff;

/** The configuration name a local archive's operation is seeded with: it is built for no project space's flags. */
export const LOCAL_CONFIGURATION = "local";

/** HMAC_DRBG over SHA-256 (NIST SP 800-90A section 10.1.2), instantiated once, never reseeded. */
class HmacDrbg {
	private key: Buffer = Buffer.alloc(32, 0x00);
	private value: Buffer = Buffer.alloc(32, 0x01);

	constructor(seed: Buffer) {
		this.update(seed);
	}

	private hmac(...parts: Buffer[]): Buffer {
		const mac = crypto.createHmac("sha256", this.key);
		for (const part of parts) mac.update(part);
		return mac.digest();
	}

	private update(data?: Buffer): void {
		this.key = this.hmac(
			this.value,
			Buffer.from([0x00]),
			data ?? Buffer.alloc(0),
		);
		this.value = this.hmac(this.value);
		if (data === undefined || data.length === 0) return;
		this.key = this.hmac(this.value, Buffer.from([0x01]), data);
		this.value = this.hmac(this.value);
	}

	generate(length: number): Buffer {
		const blocks: Buffer[] = [];
		let produced = 0;
		while (produced < length) {
			this.value = this.hmac(this.value);
			blocks.push(this.value);
			produced += this.value.length;
		}
		this.update();
		return Buffer.concat(blocks).subarray(0, length);
	}
}

/** The seed material of one operation: document-agnostic by design. */
export function operationSeed(operation: EntropyOperation): Buffer {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				"nova-proof-entropy",
				operation.seed,
				operation.ordinal,
				operation.configuration,
			]),
		)
		.digest();
}

interface Scope {
	readonly drbg: HmacDrbg;
	readonly operation: EntropyOperation;
}

interface Trace {
	readonly directory: string;
	readonly counts: Map<string, number>;
}

/** What every copy of this module shares, on `globalThis`. */
interface EntropyState {
	readonly storage: AsyncLocalStorage<Scope>;
	readonly trace: Trace | undefined;
}

const STATE_KEY = Symbol.for("nova.proof.entropy");

type Writable = Record<string, unknown>;

function state(): EntropyState | undefined {
	return (globalThis as unknown as Record<symbol, EntropyState | undefined>)[
		STATE_KEY
	];
}

/** How many frames a census stack holds, whatever limit the running code set. */
const CENSUS_STACK_FRAMES = 64;

/**
 * The first stack frame outside this module and Node's own, or, when only
 * Node's own called (its bundled undici, its timers), the first of those.
 * The stack is captured with room for every frame, whatever
 * `Error.stackTraceLimit` the code on the stack set; a stack with no frame
 * outside this module is recorded whole.
 */
function caller(): string {
	const limit = Error.stackTraceLimit;
	let stack: string;
	try {
		Error.stackTraceLimit = CENSUS_STACK_FRAMES;
		stack = new Error().stack ?? "";
	} finally {
		Error.stackTraceLimit = limit;
	}
	const frames = stack
		.split("\n")
		.slice(1)
		.map((line) => line.trim().replace(/^at /, ""))
		.filter((frame) => !frame.includes("/proof/corpus/entropy.mts"));
	return (
		frames.find(
			(frame) => !frame.includes("node:") && !frame.includes("(native)"),
		) ??
		frames[0] ??
		`no frame outside this module in: ${stack.replace(/\s+/g, " ")}`
	);
}

function record(trace: Trace | undefined, kind: string): void {
	if (trace === undefined) return;
	const key = `${kind} ${caller()}`;
	trace.counts.set(key, (trace.counts.get(key) ?? 0) + 1);
}

/** The bytes a typed array, `DataView` or `ArrayBuffer` holds, as one writable view. */
function bytesOf(target: ArrayBufferLike | ArrayBufferView): Uint8Array {
	return ArrayBuffer.isView(target)
		? new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
		: new Uint8Array(target);
}

function formatUuid(bytes: Buffer): string {
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A uniform integer in [min, max) from the scope's generator, drawn as
 * Node's `randomInt` draws one: 48 bits at a time, rejecting each draw at
 * or above `RAND_MAX - RAND_MAX % range`.
 */
function scopedInt(scope: Scope, min: number, max: number): number {
	const range = max - min;
	const limit = RAND_MAX - (RAND_MAX % range);
	while (true) {
		const value = scope.drbg.generate(6).readUIntBE(0, 6);
		if (value < limit) return min + (value % range);
	}
}

const INTEGER_ARRAYS = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	BigInt64Array,
	BigUint64Array,
];

function install(): EntropyState {
	const existing = state();
	if (existing !== undefined) return existing;
	const storage = new AsyncLocalStorage<Scope>();
	const traceDirectory = process.env.PROOF_ENTROPY_TRACE;
	const trace: Trace | undefined =
		traceDirectory === undefined || traceDirectory === ""
			? undefined
			: { directory: traceDirectory, counts: new Map() };
	const installed: EntropyState = { storage, trace };
	(globalThis as unknown as Record<symbol, EntropyState>)[STATE_KEY] =
		installed;

	const exports = crypto as unknown as Writable;
	const original = {
		randomBytes: crypto.randomBytes,
		randomFill: crypto.randomFill,
		randomFillSync: crypto.randomFillSync,
		randomUUID: crypto.randomUUID,
		randomInt: crypto.randomInt,
	};
	const webcrypto = globalThis.crypto;
	const webGetRandomValues = webcrypto.getRandomValues.bind(webcrypto);
	const webRandomUUID = webcrypto.randomUUID.bind(webcrypto);

	function randomBytes(...args: unknown[]): unknown {
		const [size, callback] = args;
		const scope = storage.getStore();
		record(trace, `${scope === undefined ? "real" : "seeded"} randomBytes`);
		if (
			scope === undefined ||
			typeof size !== "number" ||
			!Number.isSafeInteger(size) ||
			size < 0
		) {
			return Reflect.apply(original.randomBytes, crypto, args);
		}
		const bytes = scope.drbg.generate(size);
		if (typeof callback === "function") {
			process.nextTick(
				callback as (error: null, bytes: Buffer) => void,
				null,
				bytes,
			);
			return undefined;
		}
		return bytes;
	}

	/** Where a `randomFill` call writes, in bytes, or `undefined` when Node's own checks must answer. */
	function fillRange(
		target: unknown,
		offset: unknown,
		size: unknown,
	): Uint8Array | undefined {
		if (!(target instanceof ArrayBuffer) && !ArrayBuffer.isView(target)) {
			return undefined;
		}
		const view = bytesOf(target);
		const element =
			ArrayBuffer.isView(target) && "BYTES_PER_ELEMENT" in target
				? (target as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
				: 1;
		const start = (offset === undefined ? 0 : (offset as number)) * element;
		const length =
			size === undefined ? view.length - start : (size as number) * element;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(length) ||
			start < 0 ||
			length < 0 ||
			start + length > view.length
		) {
			return undefined;
		}
		return view.subarray(start, start + length);
	}

	function randomFillSync(...args: unknown[]): unknown {
		const [target, offset, size] = args;
		const scope = storage.getStore();
		record(trace, `${scope === undefined ? "real" : "seeded"} randomFillSync`);
		const range =
			scope === undefined ? undefined : fillRange(target, offset, size);
		if (scope === undefined || range === undefined) {
			return Reflect.apply(original.randomFillSync, crypto, args);
		}
		range.set(scope.drbg.generate(range.length));
		return target;
	}

	function randomFill(target: unknown, ...rest: unknown[]): void {
		const scope = storage.getStore();
		record(trace, `${scope === undefined ? "real" : "seeded"} randomFill`);
		const callback = rest.at(-1);
		const [offset, size] = rest.slice(0, -1);
		const range =
			scope === undefined || typeof callback !== "function"
				? undefined
				: fillRange(target, offset, size);
		if (scope === undefined || range === undefined) {
			Reflect.apply(original.randomFill, crypto, [target, ...rest]);
			return;
		}
		range.set(scope.drbg.generate(range.length));
		process.nextTick(
			callback as (error: null, filled: unknown) => void,
			null,
			target,
		);
	}

	function randomUUID(...args: unknown[]): string {
		const scope = storage.getStore();
		record(trace, `${scope === undefined ? "real" : "seeded"} randomUUID`);
		if (scope === undefined) {
			return Reflect.apply(original.randomUUID, crypto, args) as string;
		}
		return formatUuid(scope.drbg.generate(16));
	}

	function randomInt(...args: unknown[]): unknown {
		const scope = storage.getStore();
		record(trace, `${scope === undefined ? "real" : "seeded"} randomInt`);
		const callback =
			typeof args.at(-1) === "function" ? args.at(-1) : undefined;
		const bounds = callback === undefined ? args : args.slice(0, -1);
		const [min, max] = bounds.length === 1 ? [0, bounds[0]] : bounds;
		if (
			scope === undefined ||
			!Number.isSafeInteger(min) ||
			!Number.isSafeInteger(max) ||
			(max as number) <= (min as number) ||
			(max as number) - (min as number) > RAND_MAX
		) {
			// Node's own answers every refusal (an unsafe bound, an empty or too wide range).
			return Reflect.apply(original.randomInt, crypto, args);
		}
		const value = scopedInt(scope, min as number, max as number);
		if (callback !== undefined) {
			process.nextTick(
				callback as (error: undefined, value: number) => void,
				undefined,
				value,
			);
			return undefined;
		}
		return value;
	}

	function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
		const scope = storage.getStore();
		record(trace, `${scope === undefined ? "real" : "seeded"} getRandomValues`);
		if (
			scope === undefined ||
			array === null ||
			!INTEGER_ARRAYS.some((type) => array instanceof type) ||
			(array as ArrayBufferView).byteLength > 65_536
		) {
			// Node's own answers every refusal (a float array, more than 64 KiB).
			return webGetRandomValues(array as never) as T;
		}
		bytesOf(array as ArrayBufferView).set(
			scope.drbg.generate((array as ArrayBufferView).byteLength),
		);
		return array;
	}

	function webUuid(): string {
		const scope = storage.getStore();
		record(
			trace,
			`${scope === undefined ? "real" : "seeded"} crypto.randomUUID`,
		);
		if (scope === undefined) return webRandomUUID();
		return formatUuid(scope.drbg.generate(16));
	}

	for (const name of ["randomBytes", "pseudoRandomBytes", "prng", "rng"]) {
		if (typeof exports[name] === "function") exports[name] = randomBytes;
	}
	exports.randomFillSync = randomFillSync;
	exports.randomFill = randomFill;
	exports.randomUUID = randomUUID;
	exports.randomInt = randomInt;
	syncBuiltinESMExports();
	Object.defineProperty(webcrypto, "getRandomValues", {
		value: getRandomValues,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(webcrypto, "randomUUID", {
		value: webUuid,
		configurable: true,
		writable: true,
	});

	if (trace !== undefined) traceClocks(storage, trace);
	return installed;
}

/**
 * With tracing on, count the clock and `Math.random` reads made inside an
 * operation: none of them may reach an export's bytes, so the census names
 * where each comes from.
 */
function traceClocks(storage: AsyncLocalStorage<Scope>, trace: Trace): void {
	const RealDate = globalThis.Date;
	const realRandom = Math.random;
	globalThis.Date = new Proxy(RealDate, {
		construct(target, args, newTarget) {
			if (args.length === 0 && storage.getStore() !== undefined) {
				record(trace, "scoped new Date()");
			}
			return Reflect.construct(target, args, newTarget);
		},
		get(target, property, receiver) {
			if (property === "now") {
				return () => {
					if (storage.getStore() !== undefined)
						record(trace, "scoped Date.now");
					return target.now();
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	Math.random = () => {
		if (storage.getStore() !== undefined) record(trace, "scoped Math.random");
		return realRandom();
	};
	process.on("exit", () => {
		writeFileSync(
			join(trace.directory, `entropy-${process.pid}.json`),
			`${JSON.stringify(Object.fromEntries([...trace.counts].sort()), null, "\t")}\n`,
		);
	});
}

/** Whether exports are seeded in this process: the preload or an import installed the generator. */
export function entropySeeded(): boolean {
	return state() !== undefined;
}

/**
 * Run one export operation with its draws answered from its own generator.
 * Without an operation, or with seeding off (`PROOF_ENTROPY=real`), `run`
 * draws real entropy. Everything `run` starts, synchronously or through
 * promises, draws from the same generator, so an operation's draws must be
 * sequential for its bytes to be reproducible.
 */
export function seeded<T>(
	operation: EntropyOperation | undefined,
	run: () => T,
): T {
	const installed = state();
	if (installed === undefined || operation === undefined) return run();
	return installed.storage.run(
		{ drbg: new HmacDrbg(operationSeed(operation)), operation },
		run,
	);
}

if (process.env.PROOF_ENTROPY !== "real") install();
