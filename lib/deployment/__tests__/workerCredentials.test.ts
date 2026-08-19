/**
 * The password Nova generates for a new mobile worker.
 *
 * Two separate promises are pinned here. One is that the password is
 * strong and typable — a person reads it off a screen and types it into a
 * phone, so an alphabet full of look-alike characters is a support call,
 * and CommCare HQ's own `domain/extension_points.py::validate_password_rules`
 * scores what it gets when a project space turns strong passwords on.
 *
 * The other is the one that matters: **it exists in the answer and
 * nowhere else.** Nothing writes it to Postgres and nothing logs it. The
 * logging half is proved against the real driver rather than by reading
 * the code, because a refusal that echoed the request body would put every
 * generated password in Cloud Logging forever and would look perfectly
 * ordinary in review.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const logCalls: unknown[][] = [];
vi.mock("@/lib/logger", () => ({
	log: {
		info: (...args: unknown[]) => logCalls.push(args),
		warn: (...args: unknown[]) => logCalls.push(args),
		error: (...args: unknown[]) => logCalls.push(args),
		critical: (...args: unknown[]) => logCalls.push(args),
		debug: (...args: unknown[]) => logCalls.push(args),
	},
}));

const { generateWorkerPassword } = await import("../workerCredentials");
const { createHqMobileWorker } = await import("@/lib/commcare/hq/workers");

describe("generateWorkerPassword", () => {
	it("carries one of every character class CommCare HQ's own generator does", () => {
		// `users/forms.py::generate_strong_password` guarantees lower, upper,
		// digit, and punctuation. A run of twenty lowercase letters would be
		// legal by chance and refused by a project space that scores.
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const password = generateWorkerPassword();
			expect(password).toMatch(/[a-z]/);
			expect(password).toMatch(/[A-Z]/);
			expect(password).toMatch(/[0-9]/);
			expect(password).toMatch(/[!@#$%&*?\-+=]/);
			expect(password).toHaveLength(20);
		}
	});

	it("holds no character a person can mistake for another", () => {
		const confusable = /[l1IO0]/;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			expect(generateWorkerPassword()).not.toMatch(confusable);
		}
	});

	it("gives a different answer every time", () => {
		const seen = new Set(
			Array.from({ length: 200 }, () => generateWorkerPassword()),
		);
		expect(seen.size).toBe(200);
	});
});

describe("a password never reaches a log", () => {
	const CREDS = {
		username: "user@example.org",
		apiKey: "abc123",
		server: "production",
	} as const;
	let fetchMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logCalls.length = 0;
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("keeps it out of the refusal the driver files", async () => {
		const password = generateWorkerPassword();
		/* CommCare HQ's 400 bodies do not echo the request, but a driver
		 * that logged what it SENT would, so the refusal path is exercised
		 * with a body that contains the password to make the leak
		 * detectable if one is ever added. */
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: `rejected ${password}` }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await createHqMobileWorker(CREDS, "myproject", {
			username: "amina",
			password,
		});
		expect(result).toMatchObject({ success: false, status: 400 });

		expect(logCalls.length).toBeGreaterThan(0);
		expect(JSON.stringify(logCalls)).not.toContain(password);
	});

	it("keeps it out of anything the driver files on a success", async () => {
		const password = generateWorkerPassword();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "u9" }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await createHqMobileWorker(CREDS, "myproject", {
			username: "amina",
			password,
		});
		expect(JSON.stringify(logCalls)).not.toContain(password);
	});
});
