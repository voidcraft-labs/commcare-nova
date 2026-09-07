import { expect, it } from "vitest";
import {
	workerCredentialRows,
	workerCredentialsText,
} from "@/lib/deployment/workerCredentialRows";
import { provisioningOutcomeKey } from "@/lib/deployment/workerProvisionPlan";
import { createBuilderSessionStore } from "../store";

const doubtful = {
	personaUuid: "persona",
	personaName: "Amina",
	username: "amina@clinic.commcarehq.org",
	password: "first-password",
};
const answer = {
	server: "production",
	domain: "clinic",
	workers: [],
	refusal: null,
};
const key = provisioningOutcomeKey("production", "clinic");

it("retains every candidate across uncertain retries and deduplicates identical responses", () => {
	const store = createBuilderSessionStore();
	store
		.getState()
		.recordProvisioningOutcome({ ...answer, unconfirmed: [doubtful] });
	const first = store.getState().provisioningOutcomes[key];
	const retry = {
		...answer,
		unconfirmed: [{ ...doubtful, password: "second-password" }],
	};
	store.getState().recordProvisioningOutcome(retry);
	store.getState().recordProvisioningOutcome(retry);
	expect(
		Object.values(store.getState().provisioningOutcomes[key].unconfirmed),
	).toEqual([doubtful, { ...doubtful, password: "second-password" }]);
	expect(Object.values(first.unconfirmed)).toEqual([doubtful]);
});

it("isolates uncertain credentials from same-named destinations and scopes dismissal", () => {
	const store = createBuilderSessionStore();
	const record = store.getState().recordProvisioningOutcome;
	record({ ...answer, unconfirmed: [doubtful] });
	record({
		...answer,
		server: "india",
		unconfirmed: [{ ...doubtful, password: "india-password" }],
	});
	const india = provisioningOutcomeKey("india", "clinic");
	const us = store.getState().provisioningOutcomes[key];
	expect(Object.values(us.unconfirmed)).toEqual([doubtful]);
	expect(
		Object.values(store.getState().provisioningOutcomes[india].unconfirmed).map(
			(row) => row.password,
		),
	).toEqual(["india-password"]);
	record({
		...answer,
		server: "india",
		workers: [
			{
				...doubtful,
				password: "confirmed-india",
				userId: "india-user",
				created: true,
				adopted: false,
			},
		],
	});
	expect(store.getState().provisioningOutcomes[key]).toBe(us);
	expect(store.getState().provisioningOutcomes[india].unconfirmed).toEqual({});
	store
		.getState()
		.dismissUnconfirmedWorker(
			"india",
			"clinic",
			Object.keys(us.unconfirmed)[0],
		);
	expect(store.getState().provisioningOutcomes[key]).toBe(us);
	store
		.getState()
		.dismissUnconfirmedWorker(
			"production",
			"clinic",
			Object.keys(us.unconfirmed)[0],
		);
	expect(store.getState().provisioningOutcomes[key].unconfirmed).toEqual({});
	store.getState().reset();
	expect(store.getState().provisioningOutcomes).toEqual({});
});

it("a confirmed create clears every old candidate only for that exact persona and username", () => {
	const store = createBuilderSessionStore();
	store.getState().recordProvisioningOutcome({
		...answer,
		unconfirmed: [
			doubtful,
			{ ...doubtful, password: "second" },
			{
				...doubtful,
				username: "other@clinic.commcarehq.org",
				password: "other",
			},
		],
	});
	store.getState().recordProvisioningOutcome({
		...answer,
		workers: [
			{
				...doubtful,
				password: "confirmed",
				userId: "new-user",
				created: true,
				adopted: false,
			},
		],
	});
	expect(
		Object.values(store.getState().provisioningOutcomes[key].unconfirmed),
	).toEqual([
		{ ...doubtful, username: "other@clinic.commcarehq.org", password: "other" },
	]);
});

it("does not certify a retained password when the same username now identifies a different account", () => {
	const store = createBuilderSessionStore();
	const record = store.getState().recordProvisioningOutcome;
	const original = {
		...doubtful,
		userId: "original",
		created: true,
		adopted: false,
	};
	record({ ...answer, workers: [original] });
	// Ordinary updates keep a credential only while remote identity agrees.
	record({
		...answer,
		workers: [{ ...original, created: false, password: null }],
	});
	expect(store.getState().provisioningOutcomes[key].workers[0].password).toBe(
		doubtful.password,
	);
	const replacement = {
		...original,
		userId: "replacement",
		created: false,
		adopted: true,
		password: null,
	};
	record({ ...answer, workers: [replacement] });
	const held = store.getState().provisioningOutcomes[key];
	expect(held.workers).toEqual([replacement]);
	expect(Object.values(held.unconfirmed)).toEqual([doubtful]);
	const rows = workerCredentialRows(
		held.workers,
		Object.entries(held.unconfirmed),
	);
	expect(rows).toHaveLength(1);
	expect(workerCredentialsText(rows)).toBe(
		`${doubtful.username}\t${doubtful.password}\tPassword unconfirmed`,
	);
	record({ ...answer, workers: [replacement] });
	expect(store.getState().provisioningOutcomes[key]).toEqual(held);
});
