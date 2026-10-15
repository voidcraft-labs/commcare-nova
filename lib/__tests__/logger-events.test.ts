import { type Event, Scope } from "@sentry/core";
import * as Sentry from "@sentry/nextjs";
import {
	defaultStackParser,
	linkedErrorsIntegration,
	NodeClient,
} from "@sentry/node";
import { expect, it, vi } from "vitest";

const { log } = await vi.importActual<typeof import("../logger")>("../logger");

it("builds message-only events and preserves original exception frames and causes", async () => {
	const events: Event[] = [];
	const client = new NodeClient({
		dsn: "https://public@example.invalid/1",
		attachStacktrace: true,
		stackParser: defaultStackParser,
		integrations: [linkedErrorsIntegration()],
		transport: () => ({
			send: async (envelope) => {
				for (const [header, payload] of envelope[1]) {
					if (header.type === "event") events.push(payload as Event);
				}
				return { statusCode: 200 };
			},
			flush: async () => true,
		}),
	});
	client.init();
	const scope = new Scope();
	scope.setClient(client);
	vi.mocked(Sentry.captureEvent).mockImplementation((event, hint) =>
		scope.captureEvent(event, hint),
	);
	vi.mocked(Sentry.captureException).mockImplementation((error) =>
		scope.captureException(error),
	);
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		log.error("[test] exact diagnostic");
		const original = new Error("original failure", {
			cause: new Error("root cause"),
		});
		log.error("[test] safe summary", original);
		await client.flush();
		expect(events).toHaveLength(2);
		expect(events[1].exception?.values?.[0].value).toBe("root cause");
		expect(events[0].message).toBe("[test] exact diagnostic");
		expect(events[0].exception).toBeUndefined();
		expect(events[1].exception?.values?.at(-1)).toMatchObject({
			type: "Error",
			value: "original failure",
		});
		const frames = events[1].exception?.values?.at(-1)?.stacktrace?.frames;
		expect(
			frames?.some((frame) => frame.filename?.includes("logger-events.test")),
		).toBe(true);
		expect(frames?.some((frame) => frame.function === "captureToSentry")).toBe(
			false,
		);
		expect(vi.mocked(Sentry.captureException).mock.lastCall?.[0]).toBe(
			original,
		);
	} finally {
		await client.close();
		consoleError.mockRestore();
		vi.mocked(Sentry.captureEvent).mockReset();
		vi.mocked(Sentry.captureException).mockReset();
	}
});
