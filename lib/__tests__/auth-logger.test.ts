import { describe, expect, it, vi } from "vitest";
import { type AuthLogSink, forwardBetterAuthLog } from "../auth-logger";

function fakeSink() {
	return {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
	} satisfies AuthLogSink;
}

describe("forwardBetterAuthLog", () => {
	it("routes `error` to sink.error so it reaches Sentry, with the Error extracted", () => {
		const sink = fakeSink();
		const err = new Error("adapter blew up");
		forwardBetterAuthLog("error", "token exchange failed", [err], sink);

		expect(sink.error).toHaveBeenCalledWith(
			"[better-auth] token exchange failed",
			err,
			undefined,
		);
		expect(sink.warn).not.toHaveBeenCalled();
		expect(sink.info).not.toHaveBeenCalled();
	});

	it("routes `warn` to sink.warn (Cloud-Logging-only, no Sentry)", () => {
		const sink = fakeSink();
		forwardBetterAuthLog("warn", "rate limit near cap", [], sink);
		expect(sink.warn).toHaveBeenCalledWith(
			"[better-auth] rate limit near cap",
			undefined,
		);
		expect(sink.error).not.toHaveBeenCalled();
	});

	it("routes `info` and `debug` to sink.info", () => {
		const sink = fakeSink();
		forwardBetterAuthLog("info", "started", [], sink);
		forwardBetterAuthLog("debug", "trace", [], sink);
		expect(sink.info).toHaveBeenNthCalledWith(
			1,
			"[better-auth] started",
			undefined,
		);
		expect(sink.info).toHaveBeenNthCalledWith(
			2,
			"[better-auth] trace",
			undefined,
		);
		expect(sink.error).not.toHaveBeenCalled();
		expect(sink.warn).not.toHaveBeenCalled();
	});

	it("passes the first Error as the error arg and the rest as context", () => {
		const sink = fakeSink();
		const err = new Error("boom");
		forwardBetterAuthLog(
			"error",
			"failed",
			[{ path: "/oauth2/token" }, err],
			sink,
		);
		expect(sink.error).toHaveBeenCalledWith("[better-auth] failed", err, {
			args: [{ path: "/oauth2/token" }],
		});
	});

	it("omits context when there are no non-Error args", () => {
		const sink = fakeSink();
		forwardBetterAuthLog("error", "plain", [], sink);
		expect(sink.error).toHaveBeenCalledWith(
			"[better-auth] plain",
			undefined,
			undefined,
		);
	});
});

it.each(["wrong-log", "wrong-code", "cause", "second-error"])(
	"does not suppress a state-like failure with %s",
	(variant) => {
		const sink = fakeSink();
		const error = Object.assign(
			new Error(
				"State mismatch: verification not found",
				variant === "cause"
					? { cause: new Error("database unavailable") }
					: undefined,
			),
			{
				name: "BetterAuthError",
				code:
					variant === "wrong-code"
						? "state_security_mismatch"
						: "state_mismatch",
			},
		);
		const args =
			variant === "second-error"
				? [error, new Error("other failure")]
				: [error];
		forwardBetterAuthLog(
			"error",
			variant === "wrong-log"
				? "Failed to create verification"
				: "Failed to parse state",
			args,
			sink,
		);
		expect(sink.error).toHaveBeenCalled();
		expect(sink.info).not.toHaveBeenCalled();
	},
);

it("keeps an exception on the no-state log path as an error", () => {
	const sink = fakeSink();
	const error = new Error("database unavailable");
	forwardBetterAuthLog("error", "State not found", [error], sink);
	expect(sink.error).toHaveBeenCalledWith(
		"[better-auth] State not found",
		error,
		undefined,
	);
	expect(sink.info).not.toHaveBeenCalled();
});
