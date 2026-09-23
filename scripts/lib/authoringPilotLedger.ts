import { randomUUID } from "node:crypto";
import { open, realpath, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { estimateCost } from "@/lib/db/usage";
import { LONG_CONTEXT_INPUT_THRESHOLD, MODEL_PRICING } from "@/lib/models";

/** A crashed owner leaves its lock and pending reservations for inspection. */
export async function withPilotLedger<T>(
	path: string,
	run: (file: {
		path: string;
		save: (value: unknown) => Promise<void>;
	}) => Promise<T>,
): Promise<T> {
	const resolved = await realpath(path);
	const lockPath = `${resolved}.lock`;
	const lock = await open(lockPath, "wx", 0o600);
	try {
		await lock.writeFile(String(process.pid));
		return await run({
			path: resolved,
			save: async (value) => {
				const temporary = `${resolved}.${randomUUID()}.tmp`;
				try {
					const file = await open(temporary, "wx", 0o600);
					try {
						await file.writeFile(JSON.stringify(value, null, 2));
						await file.sync();
					} finally {
						await file.close();
					}
					await rename(temporary, resolved);
				} finally {
					await rm(temporary, { force: true });
				}
			},
		});
	} finally {
		try {
			await lock.close();
		} finally {
			await rm(lockPath);
		}
	}
}

export function completedPilotCharge(
	model: string,
	usage: {
		inputTokens?: number;
		outputTokens?: number;
		inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
	},
	reservedUsd: number,
) {
	const { inputTokens, outputTokens } = usage;
	if (
		!Object.hasOwn(MODEL_PRICING, model) ||
		typeof inputTokens !== "number" ||
		!Number.isSafeInteger(inputTokens) ||
		inputTokens < 0 ||
		typeof outputTokens !== "number" ||
		!Number.isSafeInteger(outputTokens) ||
		outputTokens < 0
	)
		return { status: "completed-unmetered", estimatedUsd: reservedUsd };
	// Settle known usage using the production rate card. Missing or inconsistent
	// cache breakdowns retain the conservative all-input price; unknown calls
	// still retain their full pre-dispatch reservation above.
	const read = usage.inputTokenDetails?.cacheReadTokens;
	const write = usage.inputTokenDetails?.cacheWriteTokens;
	const cacheKnown =
		typeof read === "number" &&
		Number.isSafeInteger(read) &&
		read >= 0 &&
		typeof write === "number" &&
		Number.isSafeInteger(write) &&
		write >= 0 &&
		read + write <= inputTokens;
	const pricing =
		MODEL_PRICING[model][
			inputTokens > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short"
		];
	return {
		status: "completed",
		estimatedUsd: cacheKnown
			? estimateCost(model, inputTokens, outputTokens, read, write)
			: (inputTokens *
					Math.max(pricing.input, pricing.cacheWrite, pricing.cacheRead) +
					outputTokens * pricing.output) /
				1_000_000,
	};
}

/** Standard processing only. Reserve all input at the most expensive input
 * rate; no prospective cache hit or short-context discount is assumed. */
export function pilotReservation(
	model: string,
	inputTokens: number,
	maxOutputTokens: number,
): number {
	if (!Object.hasOwn(MODEL_PRICING, model))
		throw new Error(`No trial rate card for ${model}.`);
	for (const count of [inputTokens, maxOutputTokens])
		if (!Number.isSafeInteger(count) || count < 0)
			throw new Error("Invalid trial token bound.");
	const rates = Object.values(MODEL_PRICING[model]);
	return (
		(inputTokens *
			Math.max(...rates.flatMap((p) => [p.input, p.cacheWrite, p.cacheRead])) +
			maxOutputTokens * Math.max(...rates.map((p) => p.output))) /
		1_000_000
	);
}

/** Set Standard explicitly before capture and dispatch, independent of account
 * defaults. The saved request is the request whose cost was reserved. */
export function standardPilotTransport(transport: typeof fetch): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		if (!new URL(request.url).pathname.endsWith("/responses"))
			return transport(input, init);
		const body = z
			.record(z.string(), z.unknown())
			.parse(await request.clone().json());
		body.service_tier = "default";
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		// Node's built-in Request and npm Undici's Request are different classes.
		// Pass serialized values across the production transport boundary.
		return transport(request.url, {
			...init,
			method: request.method,
			headers: Object.fromEntries(headers),
			body: JSON.stringify(body),
			signal: request.signal,
		});
	};
}

const ledgerFields = {
	ceilingUsd: z.number().positive().max(200),
	targetUsd: z.number().positive(),
	estimatedSpentUsd: z.number().nonnegative(),
	calls: z.array(z.record(z.string(), z.unknown())),
};
export const pilotLedgerSchema = z.object({
	accountingVersion: z.literal(2),
	...ledgerFields,
});
export type PilotLedger = z.infer<typeof pilotLedgerSchema>;

export function pilotCallCharge(call: Record<string, unknown>): number {
	const amount =
		call.status === "completed" ? call.estimatedUsd : call.reservedUsd;
	if (
		!["completed", "pending", "completed-unmetered"].includes(
			String(call.status),
		) ||
		typeof amount !== "number" ||
		!Number.isFinite(amount) ||
		amount < 0
	)
		throw new Error("A trial call has no valid charge or reservation.");
	return amount;
}

export function readPilotLedger(value: unknown): PilotLedger {
	const ledger = pilotLedgerSchema.parse(value);
	const sum = ledger.calls.reduce(
		(total, call) => total + pilotCallCharge(call),
		0,
	);
	if (Math.abs(sum - ledger.estimatedSpentUsd) > 0.000001)
		throw new Error("Trial ledger total does not match its calls.");
	return ledger;
}

/** One-time conversion, never a runtime compatibility branch. The caller keeps
 * the original file and writes the reconciled ledger to a new path. */
export function reconcilePilotLedger(value: unknown, ceilingUsd: number) {
	const old = z
		.object({ accountingVersion: z.never().optional(), ...ledgerFields })
		.parse(value);
	const previousSum = old.calls.reduce(
		(sum, call) => sum + pilotCallCharge(call),
		0,
	);
	if (Math.abs(previousSum - old.estimatedSpentUsd) > 0.000001)
		throw new Error("Original trial ledger total does not match its calls.");
	const calls = old.calls.map((call) => {
		pilotCallCharge(call);
		if (call.status !== "completed") return call;
		const model = z.string().parse(call.model);
		const usage = z
			.object({
				inputTokens: z.number().int().nonnegative(),
				outputTokens: z.number().int().nonnegative(),
				inputTokenDetails: z
					.object({
						cacheReadTokens: z.number().optional(),
						cacheWriteTokens: z.number().optional(),
					})
					.optional(),
			})
			.parse(call.usage);
		const reserved = z.number().nonnegative().parse(call.reservedUsd);
		return { ...call, ...completedPilotCharge(model, usage, reserved) };
	});
	const ledger = readPilotLedger({
		accountingVersion: 2,
		ceilingUsd,
		targetUsd: ceilingUsd,
		estimatedSpentUsd: calls.reduce(
			(total, call) => total + pilotCallCharge(call),
			0,
		),
		calls,
	});
	if (ledger.estimatedSpentUsd > ceilingUsd)
		throw new Error("Reconciled charges exceed the authorized ceiling.");
	return {
		ledger,
		previousEstimatedSpentUsd: old.estimatedSpentUsd,
		removedMarginUsd: old.estimatedSpentUsd - ledger.estimatedSpentUsd,
	};
}
