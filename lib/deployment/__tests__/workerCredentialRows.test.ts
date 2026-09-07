import { expect, it } from "vitest";
import {
	workerCredentialRows,
	workerCredentialsText,
} from "../workerCredentialRows";
import type {
	ProvisionedWorker,
	UnconfirmedWorker,
} from "../workerProvisionPlan";

const candidate: UnconfirmedWorker = {
	personaUuid: "amina",
	personaName: "Amina",
	username: "amina@clinic.commcarehq.org",
	password: "candidate-one",
};
const worker: ProvisionedWorker = {
	...candidate,
	userId: "worker-1",
	adopted: true,
	created: false,
	password: null,
};

it("retains every candidate for an adopted account without claiming a password was confirmed", () => {
	const rows = workerCredentialRows(
		[worker],
		[
			["first", candidate],
			["second", { ...candidate, password: "candidate-two" }],
		],
	);
	expect(
		rows.map((row) => [row.password, row.uncertainty, row.dismissKey]),
	).toEqual([
		["candidate-one", "password", "first"],
		["candidate-two", "password", "second"],
	]);
	expect(new Set(rows.map((row) => row.key)).size).toBe(2);
	expect(workerCredentialsText(rows)).toBe(
		"amina@clinic.commcarehq.org\tcandidate-one\tPassword unconfirmed\namina@clinic.commcarehq.org\tcandidate-two\tPassword unconfirmed",
	);
});
it("keeps uncertain account names separate from confirmed credentials and carries uncertainty into copy", () => {
	const rows = workerCredentialRows(
		[{ ...worker, password: "confirmed" }],
		[["other", { ...candidate, username: "other@clinic.commcarehq.org" }]],
	);
	expect(
		rows.map((row) => [row.username, row.password, row.uncertainty]),
	).toEqual([
		[candidate.username, "confirmed", null],
		["other@clinic.commcarehq.org", "candidate-one", "account"],
	]);
	expect(workerCredentialsText(rows)).toBe(
		"amina@clinic.commcarehq.org\tconfirmed\nother@clinic.commcarehq.org\tcandidate-one\tAccount unconfirmed",
	);
});
it("shows an updated account with no known credential and copies no blank passwords", () => {
	const rows = workerCredentialRows([worker], []);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		password: null,
		uncertainty: null,
		dismissKey: null,
	});
	expect(workerCredentialsText(rows)).toBe("");
});
