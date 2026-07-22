import { describe, expect, it } from "vitest";
import {
	parseClientStreamReceiverVersion,
	resolveDeployedStreamReceiverVersion,
	resolveEffectiveStreamReceiverVersion,
	resolveServingStreamReceiverVersion,
} from "@/lib/db/streamReceiverCapabilities";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";

const DEPLOYED_RECEIVER_V1 = Object.freeze({
	NOVA_STREAM_RECEIVER_VERSION: "1",
	NOVA_STREAM_REGISTRY_VERSION: "1",
});

function receiverQuery(...values: string[]): URLSearchParams {
	const params = new URLSearchParams({ since: "17" });
	for (const value of values) params.append("receiverVersion", value);
	return params;
}

describe("stream receiver capability admission", () => {
	it("freezes the S02c1 compiled and deployed receiver contract at v1", () => {
		expect(RUNTIME_CAPABILITIES.streamReceiverVersion).toBe(1);
		expect(RUNTIME_CAPABILITIES.streamRegistryVersion).toBe(1);
		expect(resolveDeployedStreamReceiverVersion(DEPLOYED_RECEIVER_V1)).toBe(1);
		expect(
			resolveEffectiveStreamReceiverVersion(
				receiverQuery("1"),
				DEPLOYED_RECEIVER_V1,
			),
		).toBe(1);
		expect(
			resolveEffectiveStreamReceiverVersion(
				receiverQuery("0"),
				DEPLOYED_RECEIVER_V1,
			),
		).toBe(0);
	});

	it.each([
		["0", 0],
		["1", 1],
		["2147483647", 2_147_483_647],
	])(
		"accepts exactly one strict receiver declaration %j",
		(value, expected) => {
			expect(parseClientStreamReceiverVersion(receiverQuery(value))).toBe(
				expected,
			);
		},
	);

	it.each([
		["missing", receiverQuery()],
		["empty", receiverQuery("")],
		["duplicate valid", receiverQuery("1", "1")],
		["duplicate mixed", receiverQuery("1", "bad")],
		[
			"wrong-case key",
			new URLSearchParams({ ReceiverVersion: "1", since: "17" }),
		],
		["leading zero", receiverQuery("01")],
		["positive sign", receiverQuery("+1")],
		["negative", receiverQuery("-1")],
		["integer decimal", receiverQuery("1.0")],
		["fractional", receiverQuery("1.5")],
		["exponent", receiverQuery("1e0")],
		["Postgres integer overflow", receiverQuery("2147483648")],
		["JavaScript safe-integer overflow", receiverQuery("9007199254740992")],
		["suffix", receiverQuery("1-old")],
		["NaN", receiverQuery("NaN")],
		["leading whitespace", receiverQuery(" 1")],
		["trailing whitespace", receiverQuery("1 ")],
	] as const)("fails %s client input closed to v0", (_name, params) => {
		expect(parseClientStreamReceiverVersion(params)).toBe(0);
	});

	it.each([
		["matching v1", 1, 1, 1, 1, 1],
		["deployed receiver overstates support", 1, 1, 9, 1, 1],
		["compiled receiver is newer", 9, 1, 1, 1, 1],
		["compiled receiver is v0", 0, 1, 1, 1, 0],
		["deployed receiver is v0", 1, 1, 0, 1, 0],
		["compiled registry is pre-v1", 1, 0, 1, 1, 0],
		["deployed registry is pre-v1", 1, 1, 1, 0, 0],
		["both future registries satisfy the gate", 2, 4, 3, 7, 2],
	] as const)(
		"resolves serving support for %s",
		(_name, compiledReceiver, compiledRegistry, deployedReceiver, deployedRegistry, expected) => {
			expect(
				resolveServingStreamReceiverVersion(
					{
						streamReceiverVersion: compiledReceiver,
						streamRegistryVersion: compiledRegistry,
					},
					{
						streamReceiverVersion: deployedReceiver,
						streamRegistryVersion: deployedRegistry,
					},
				),
			).toBe(expected);
		},
	);

	it.each([
		["undefined input", undefined],
		["null input", null],
		["string input", "receiver=1"],
		["array input", ["1", "1"]],
		["missing receiver", { NOVA_STREAM_REGISTRY_VERSION: "1" }],
		["missing registry", { NOVA_STREAM_RECEIVER_VERSION: "1" }],
		[
			"numeric declarations",
			{
				NOVA_STREAM_RECEIVER_VERSION: 1,
				NOVA_STREAM_REGISTRY_VERSION: 1,
			},
		],
		[
			"padded receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: " 1",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"trailing-padded receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: "1 ",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"positive-signed receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: "+1",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"negative-signed receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: "-1",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"fractional receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: "1.5",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"overflowing receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: "2147483648",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"malformed receiver",
			{
				NOVA_STREAM_RECEIVER_VERSION: "1-old",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			},
		],
		[
			"malformed registry",
			{
				NOVA_STREAM_RECEIVER_VERSION: "1",
				NOVA_STREAM_REGISTRY_VERSION: "01",
			},
		],
	] as const)("fails %s deployed input closed to v0", (_name, environment) => {
		expect(resolveDeployedStreamReceiverVersion(environment)).toBe(0);
	});

	it("takes the minimum of browser and serving revision support", () => {
		expect(
			resolveEffectiveStreamReceiverVersion(receiverQuery("2147483647"), {
				NOVA_STREAM_RECEIVER_VERSION: "99",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			}),
		).toBe(1);
		expect(
			resolveEffectiveStreamReceiverVersion(receiverQuery("bad"), {
				NOVA_STREAM_RECEIVER_VERSION: "1",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			}),
		).toBe(0);
		expect(
			resolveEffectiveStreamReceiverVersion(receiverQuery("1"), {
				NOVA_STREAM_RECEIVER_VERSION: "1",
				NOVA_STREAM_REGISTRY_VERSION: "0",
			}),
		).toBe(0);
	});
});
