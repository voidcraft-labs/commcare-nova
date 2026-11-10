import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { DocxFigure } from "./documentFigures";
import { OFFICE_LIMITS } from "./officeLimits";

export interface OfficeResult {
	markdown: string;
	figures: DocxFigure[];
	warnings: string[];
	peakRssKb: number;
}

const failure = () =>
	new Error(
		"I couldn't read this Office file within the reading limits. You can try a smaller file or export it as a PDF.",
	);

/** The queue owns only admission. A permit is released only after the child's
 * close event, including timeout, cancellation, malformed output and spawn errors.
 * Options are process configuration, never supplied by an uploaded document. */
export class OfficeParser {
	private active = false;
	private waiting: (() => void)[] = [];
	constructor(
		private readonly options: {
			workerPath?: string;
			timeoutMs?: number;
			dataKb?: number;
			heapMb?: number;
		} = {},
	) {}

	async convert(
		bytes: Buffer,
		kind: "docx" | "xlsx",
		signal?: AbortSignal,
	): Promise<OfficeResult> {
		signal?.throwIfAborted();
		if (bytes.length > OFFICE_LIMITS.inputBytes) throw failure();
		const deadline = new AbortController();
		const timer = setTimeout(
			() => deadline.abort(failure()),
			this.options.timeoutMs ?? OFFICE_LIMITS.timeoutMs,
		);
		const cancellation = signal
			? AbortSignal.any([signal, deadline.signal])
			: deadline.signal;
		try {
			await this.acquire(cancellation);
			try {
				cancellation.throwIfAborted();
				return await this.run(bytes, kind, cancellation);
			} finally {
				const next = this.waiting.shift();
				if (next) next();
				else this.active = false;
			}
		} finally {
			clearTimeout(timer);
		}
	}

	private acquire(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!this.active) {
			this.active = true;
			return Promise.resolve();
		}
		if (this.waiting.length >= OFFICE_LIMITS.queued)
			return Promise.reject(
				new Error(
					"I'm reading several files right now. You can try this file again shortly.",
				),
			);
		return new Promise((resolve, reject) => {
			const ready = () => {
				signal.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				this.waiting = this.waiting.filter((item) => item !== ready);
				reject(signal.reason);
			};
			this.waiting.push(ready);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	private run(
		bytes: Buffer,
		kind: "docx" | "xlsx",
		signal: AbortSignal,
	): Promise<OfficeResult> {
		return new Promise((resolveResult, reject) => {
			// Fixed shell program, positional arguments only. No document text enters a
			// command. exec keeps the shell PID, so SIGKILL also joins the parser itself.
			// Linux enforces RLIMIT_DATA on heap and anonymous mmap; macOS's allocator
			// semantics differ, so Linux image verification owns the native memory proof.
			const child = spawn(
				"/bin/sh",
				[
					"-c",
					process.platform === "linux"
						? 'ulimit -c 0 && ulimit -d "$1" && exec "$2" --disable-wasm-trap-handler --max-old-space-size="$3" "$4" "$5"'
						: 'ulimit -c 0 && exec "$2" --disable-wasm-trap-handler --max-old-space-size="$3" "$4" "$5"',
					"office-parser",
					String(this.options.dataKb ?? OFFICE_LIMITS.dataKb),
					process.execPath,
					String(this.options.heapMb ?? OFFICE_LIMITS.heapMb),
					this.options.workerPath ??
						resolve(process.cwd(), "runtime/office/worker.mjs"),
					kind,
				],
				{
					stdio: ["pipe", "pipe", "ignore"],
					env: { NODE_ENV: "production", LANG: "C.UTF-8", TZ: "UTC" },
				},
			);
			const chunks: Buffer[] = [];
			let size = 0;
			let error: unknown;
			const stop = (reason: unknown) => {
				error ??= reason;
				child.kill("SIGKILL");
			};
			const abort = () => stop(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			child.on("error", stop);
			child.stdin.on("error", stop);
			child.stdout.on("error", stop);
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > OFFICE_LIMITS.resultBytes) stop(failure());
				else if (!error) chunks.push(chunk);
			});
			child.once("close", (code) => {
				signal.removeEventListener("abort", abort);
				if (error || code !== 0) {
					reject(error ?? failure());
					return;
				}
				try {
					const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					// Output comes from our fixed child, but a crash/packaging mismatch must
					// never masquerade as a successful empty conversion.
					if (
						typeof result.markdown !== "string" ||
						!Array.isArray(result.figures) ||
						!Array.isArray(result.warnings)
					)
						throw failure();
					resolveResult({
						...result,
						figures: result.figures.map(
							(figure: Omit<DocxFigure, "bytes"> & { bytes: string }) => ({
								...figure,
								bytes: Buffer.from(figure.bytes, "base64"),
							}),
						),
					});
				} catch {
					reject(failure());
				}
			});
			if (signal.aborted) abort();
			else child.stdin.end(bytes);
		});
	}
}

const globalParser = globalThis as typeof globalThis & {
	__novaOfficeParser?: OfficeParser;
};
globalParser.__novaOfficeParser ??= new OfficeParser();
const parser = globalParser.__novaOfficeParser;
export function convertOfficeDocument(
	bytes: Buffer,
	kind: "docx" | "xlsx",
	signal?: AbortSignal,
): Promise<OfficeResult> {
	return parser.convert(bytes, kind, signal);
}
