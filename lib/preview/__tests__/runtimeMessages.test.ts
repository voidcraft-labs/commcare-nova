import { describe, expect, it } from "vitest";
import {
	runtimeDateLocale,
	runtimeLanguage,
	runtimeMessage,
} from "../runtimeMessages";

describe("worker calendar language", () => {
	it("retains regional date conventions without changing the app's identity", () => {
		const date = new Date(2026, 11, 31);
		const options = { day: "numeric", month: "long", year: "numeric" } as const;
		expect(runtimeDateLocale("eng-GB")).toBe("eng-GB");
		expect(
			new Intl.DateTimeFormat(runtimeDateLocale("eng-GB"), options).format(
				date,
			),
		).toBe("31 December 2026");
		expect(
			new Intl.DateTimeFormat(runtimeDateLocale("eng-US"), options).format(
				date,
			),
		).toBe("December 31, 2026");
	});

	it("uses the Spanish catalog while retaining the selected regional date locale", () => {
		expect(runtimeLanguage("spa-MX")).toEqual({
			catalogLanguage: "spa",
			fallback: false,
		});
		expect(runtimeDateLocale("spa-MX")).toBe("spa-MX");
		expect(
			new Intl.DateTimeFormat(runtimeDateLocale("spa-MX")).resolvedOptions()
				.locale,
		).toBe("es-MX");
	});

	it("uses English widgets when the worker language has no platform catalog", () => {
		expect(runtimeLanguage("fra-FR").fallback).toBe(true);
		expect(runtimeDateLocale("fra-FR")).toBe("eng");
		expect(runtimeMessage("fra-FR", "pickDate")).toBe(
			runtimeMessage("eng", "pickDate"),
		);
		expect(runtimeDateLocale(undefined)).toBe("eng");
	});
});
