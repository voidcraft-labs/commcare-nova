import { describe, expect, it } from "vitest";
import {
	receivingRevisionCapabilities,
	receivingRevisionNames,
} from "../lib/cloudRunCapabilities";

function revision(name: string, labels?: Record<string, string>) {
	return { metadata: { name, labels } };
}

const LABELS = {
	nova_writer: "1",
	nova_stream_receiver: "3",
	nova_runtime_reader: "1",
	nova_stream_registry: "1",
	nova_manifest: "c3ecd827181b36c2",
	nova_build: "06c23670-a34f-4556-afe4-54307fcc78d3",
};

describe("receivingRevisionNames", () => {
	it("resolves a latest-revision target through the latest ready revision", () => {
		expect(
			receivingRevisionNames({
				status: {
					latestReadyRevisionName: "commcare-nova-00380-w6t",
					traffic: [{ latestRevision: true, percent: 100 }],
				},
			}),
		).toEqual(["commcare-nova-00380-w6t"]);
	});

	it("keeps every revision that can serve and drops only silent zero-percent ones", () => {
		expect(
			receivingRevisionNames({
				status: {
					latestReadyRevisionName: "rev-new",
					traffic: [
						{ revisionName: "rev-new", percent: 70 },
						{ revisionName: "rev-old", percent: 30 },
						{ revisionName: "rev-tagged", percent: 0, tag: "canary" },
						{ revisionName: "rev-retired", percent: 0 },
					],
				},
			}),
		).toEqual(["rev-new", "rev-old", "rev-tagged"]);
	});

	it("refuses a split it cannot resolve", () => {
		expect(() => receivingRevisionNames({ status: {} })).toThrow(
			"traffic split is missing",
		);
		expect(() =>
			receivingRevisionNames({
				status: { traffic: [{ latestRevision: true, percent: 100 }] },
			}),
		).toThrow("resolves to no revision name");
		expect(() =>
			receivingRevisionNames({
				status: { traffic: [{ revisionName: "rev-old", percent: 0 }] },
			}),
		).toThrow("no traffic-receiving revision");
	});

	it("refuses an unmodelled target rather than blaming the latest revision", () => {
		// No `latestRevision: true` to justify the substitution, so resolving this
		// to `latestReady` would swap a serving revision for the capable one it is
		// about to be compared against.
		expect(() =>
			receivingRevisionNames({
				status: {
					latestReadyRevisionName: "rev-new",
					traffic: [{ percent: 100 }],
				},
			}),
		).toThrow("resolves to no revision name");
	});
});

describe("receivingRevisionCapabilities", () => {
	const service = {
		status: {
			latestReadyRevisionName: "rev-new",
			traffic: [
				{ revisionName: "rev-new", percent: 50 },
				{ revisionName: "rev-old", percent: 50 },
			],
		},
	};

	it("reads BOTH declared floors — a revision can satisfy one and not the other", () => {
		expect(
			receivingRevisionCapabilities(
				[
					revision("rev-new", LABELS),
					revision("rev-old", { ...LABELS, nova_runtime_reader: "2" }),
					revision("rev-unrouted", LABELS),
				],
				service,
			),
		).toEqual([
			{
				revision: "rev-new",
				runtimeReaderVersion: 1,
				streamReceiverVersion: 3,
			},
			{
				revision: "rev-old",
				runtimeReaderVersion: 2,
				streamReceiverVersion: 3,
			},
		]);
	});

	it("reads an unlabeled or malformed revision as capability v0", () => {
		expect(
			receivingRevisionCapabilities(
				[
					revision("rev-new"),
					revision("rev-old", { ...LABELS, nova_runtime_reader: "1-old" }),
				],
				service,
			),
		).toEqual([
			{
				revision: "rev-new",
				runtimeReaderVersion: 0,
				streamReceiverVersion: 0,
			},
			{
				revision: "rev-old",
				runtimeReaderVersion: 0,
				streamReceiverVersion: 3,
			},
		]);
	});

	it("throws when a serving revision is absent from the listing", () => {
		expect(() =>
			receivingRevisionCapabilities([revision("rev-new", LABELS)], service),
		).toThrow("rev-old receives traffic but was not listed");
	});
});
