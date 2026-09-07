import { describe, expect, it } from "vitest";
import { caseTypeDisplays, planCaseTypeCreation } from "../caseTypePickerModel";

const existingNames = new Set(["client_record", "user"]);
describe("case type picker decisions", () => {
	it("normalizes natural phrases and distinguishes untouched from invalid drafts", () => {
		expect(
			planCaseTypeCreation({ draft: "Home follow-up visit", existingNames }),
		).toEqual({
			candidate: "home_follow_up_visit",
			canCreate: true,
			error: null,
		});
		expect(planCaseTypeCreation({ draft: " ", existingNames })).toEqual({
			candidate: "",
			canCreate: false,
			error: null,
		});
		expect(planCaseTypeCreation({ draft: "---", existingNames })).toEqual({
			candidate: "",
			canCreate: false,
			error: "Use at least one letter or number",
		});
	});
	it("refuses duplicates and platform-owned identifiers with a visible next step", () => {
		expect(
			planCaseTypeCreation({ draft: "Client record", existingNames }),
		).toEqual({
			candidate: "client_record",
			canCreate: false,
			error: "Client record already exists. Choose it above.",
		});
		expect(
			planCaseTypeCreation({
				draft: "Client record",
				existingNames,
				exclude: new Set(["client_record"]),
			}),
		).toEqual({
			candidate: "client_record",
			canCreate: false,
			error:
				"Client record already exists and is managed by the platform. Choose a different name.",
		});
		expect(
			planCaseTypeCreation({
				draft: "private",
				existingNames,
				exclude: new Set(["private"]),
			}).canCreate,
		).toBe(false);
	});
	it("runs contextual admission only for identifiers eligible for creation", () => {
		const choices: string[] = [];
		const choiceVerdict = (name: string) => {
			choices.push(name);
			return {
				ok: false as const,
				reason: "This workflow needs a parent case",
			};
		};
		expect(
			planCaseTypeCreation({ draft: "123", existingNames, choiceVerdict })
				.canCreate,
		).toBe(false);
		expect(choices).toEqual([]);
		expect(
			planCaseTypeCreation({ draft: "Visit", existingNames, choiceVerdict }),
		).toEqual({
			candidate: "visit",
			canCreate: false,
			error: "This workflow needs a parent case",
		});
		expect(choices).toEqual(["visit"]);
	});
	it("exposes identities only for colliding friendly labels", () => {
		expect([
			...caseTypeDisplays(["home_visit", "home-visit", "client_record"]),
		]).toEqual([
			["home_visit", { label: "Home visit", needsDisambiguation: true }],
			["home-visit", { label: "Home visit", needsDisambiguation: true }],
			["client_record", { label: "Client record", needsDisambiguation: false }],
		]);
	});
});
