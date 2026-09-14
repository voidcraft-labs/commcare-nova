import { expect, it } from "vitest";
import {
	type ProviderRequest,
	respondWithParts,
} from "@/lib/agent/__tests__/responsesParts";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import { AuthoringSession } from "@/lib/agent/build/authoringSession";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { productionModelStep } from "@/lib/agent/modelStep";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import {
	claimAndReserveDesignSessionRun,
	createAndClaimDesignSessionRun,
} from "@/lib/db/designSessions";
import {
	collectLocalizedTranslationUnits,
	collectTranslationUnits,
	languageTag,
	translationValueIntegrityIssue,
} from "@/lib/domain";
import { MODEL_ROLES } from "@/lib/models";
import { type TranslationRun, translateLanguage } from "../translateLanguage";
import { planTranslationBatches } from "../translator";

const h = setupAppStateTestDb("requested_translation_", {
	authSchema: "migrated",
});
const target = { language: "fra" };
const tag = languageTag(target);
const call = {
	toolName: "translateLanguage",
	toolCallId: "translate",
	input: { language: target },
};

async function fixture() {
	const actorUserId = "translator";
	const projectId = "translation-project";
	const runId = "translation-run";
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const claim = await createAndClaimDesignSessionRun({
		projectId,
		actorUserId,
		runId,
		cost: 1,
	});
	const authority = {
		actorUserId,
		projectId,
		runId,
		holderNonce: claim.holderNonce,
		sessionId: claim.designSessionId,
	};
	await writeAppPlan({
		authority,
		writer: { editor: "architect" },
		requestId: "plan",
		expectedRevision: 0,
		change: { markdown: "Record each loan. Offer English and French." },
	});
	const review = await beginPlanReview(authority, "peer");
	await finishPlanReview(authority, review.reviewId);
	const session = new AuthoringSession(
		authority,
		claim.proposedAppId,
		() => {},
	);
	await session.ensureWorkspace();
	expect(
		await session.shared(
			{
				toolName: "createModule",
				toolCallId: "loans",
				input: {
					name: "Loans",
					case_type: "loan",
					forms: [
						{
							name: "Lend",
							type: "registration",
							recordName: "#form/borrower",
							fields: [
								{
									kind: "text",
									id: "borrower",
									label: "Borrower",
									required: true,
								},
								{
									kind: "label",
									id: "confirmation",
									label: "Confirm {{borrower}}",
								},
							],
						},
					],
				},
			},
			"architect",
		),
	).toMatchObject({ ok: true });
	return { session, authority, claim };
}

interface BatchPayload {
	units: Array<{
		unitId: string;
		sourceText: string;
		protectedTokens: string[];
	}>;
}
function requestBatch(request: ProviderRequest): BatchPayload {
	for (const item of request.input ?? []) {
		if (item.role !== "user" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (typeof part.text !== "string") continue;
			try {
				const value = JSON.parse(part.text) as BatchPayload;
				if (Array.isArray(value.units)) return value;
			} catch {
				/* Feedback is prose. The source payload precedes it. */
			}
		}
	}
	throw new Error("No translation source in the provider request");
}

it("recovers accepted batches across a replacement run, preserves references and saves one complete language", async () => {
	const f = await fixture();
	let session = f.session;
	let authority = f.authority;
	const source = (await session.snapshot()).doc;
	const units = collectTranslationUnits(source);
	const batchCount = planTranslationBatches(units).length;
	expect(batchCount).toBeGreaterThan(1);
	const requests: ProviderRequest[] = [];
	const failures: unknown[] = [];
	let interrupt = true;
	await withResponsesPeer(
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					const wire: ProviderRequest = JSON.parse(
						Buffer.concat(chunks).toString(),
					);
					requests.push(wire);
					respondWithParts(
						response,
						[
							{
								type: "text",
								text: JSON.stringify({
									translations: requestBatch(wire).units.map((unit) => ({
										unitId: unit.unitId,
										translatedText: `Français ${unit.sourceText}`,
									})),
								}),
							},
						],
						requests.length,
					);
				} catch (error) {
					failures.push(error);
					response.writeHead(400).end();
				}
			});
		},
		async (provider) => {
			const modelStep = productionModelStep(
				provider(MODEL_ROLES.translator.modelId),
				MODEL_ROLES.translator.reasoningEffort,
				"translation-test",
			);
			const run = (): TranslationRun => ({
				designSessionId: f.claim.designSessionId,
				authority: {
					actorUserId: authority.actorUserId,
					expectedProjectId: authority.projectId,
					runId: authority.runId,
					holderNonce: authority.holderNonce,
				},
				signal: new AbortController().signal,
				modelStep,
				onRecoveredUsage: () => {},
				onStep: async () => {
					if (interrupt && requests.length === 2) {
						interrupt = false;
						throw new Error("Lost process after accepted response");
					}
				},
			});
			await expect(
				session.write(call, (ctx) => translateLanguage(ctx, target, run())),
			).rejects.toThrow("Lost process");
			expect((await session.snapshot()).doc).toEqual(source);
			await h
				.db()
				.updateTable("design_sessions")
				.set({ run_lease_expires_at: new Date(0) })
				.where("id", "=", f.claim.designSessionId)
				.execute();
			const replacement = await claimAndReserveDesignSessionRun(
				f.claim.designSessionId,
				"replacement",
				authority.actorUserId,
				1,
				authority.projectId,
			);
			authority = {
				...authority,
				runId: "replacement",
				holderNonce: replacement.holderNonce,
			};
			session = new AuthoringSession(
				authority,
				f.claim.proposedAppId,
				() => {},
			);
			await session.initialize();
			const result = await session.write(call, (ctx) =>
				translateLanguage(ctx, target, run()),
			);
			expect(result).toMatchObject({
				ok: true,
				translated: units.length,
				saved: false,
			});
			expect(requests).toHaveLength(batchCount);
			// Reopening the workspace returns its exact semantic receipt, before invoking the model.
			session = new AuthoringSession(
				authority,
				f.claim.proposedAppId,
				() => {},
			);
			await session.initialize();
			expect(
				await session.write(call, (ctx) =>
					translateLanguage(ctx, target, run()),
				),
			).toEqual(result);
			expect(requests).toHaveLength(batchCount);
			const translated = collectLocalizedTranslationUnits(
				(await session.snapshot()).doc,
				tag,
			);
			expect(translated).toHaveLength(units.length);
			for (const unit of translated) {
				expect(unit.status).toBe("needs-review");
				expect(unit.explicit).toMatchObject({
					origin: "ai",
					sourceFingerprint: unit.sourceFingerprint,
				});
				expect(
					translationValueIntegrityIssue(unit, unit.effective),
				).toBeUndefined();
			}
			const confirmation = translated.find(
				(unit) =>
					unit.context.fieldId === "confirmation" &&
					unit.role === "field-label",
			);
			expect(confirmation?.effective).toMatchObject({
				parts: expect.arrayContaining([
					{
						kind: "field-ref",
						uuid: Object.values(source.fields).find(
							(field) => field.id === "borrower",
						)?.uuid,
					},
				]),
			});
			expect(await session.saveWork("save-translated-app")).toMatchObject({
				saved: true,
				revision: 1,
			});
			const app = await loadApp(f.claim.proposedAppId);
			expect(
				(
					await loadCanonicalBlueprintAtSequence(h.db(), {
						appId: f.claim.proposedAppId,
						seq: 1,
						expectedDigest: null,
					})
				).snapshot,
			).toEqual(app?.blueprint);
			expect(app?.blueprint.localization?.translations[tag]).toHaveProperty(
				confirmation?.id ?? "missing",
			);
			const contexts = await h
				.db()
				.selectFrom("design_model_contexts")
				.select(["id", "supersedes_context_id"])
				.where("context_kind", "=", "translator")
				.execute();
			expect(contexts).toHaveLength(batchCount);
			expect(
				contexts.every((context) => context.supersedes_context_id === null),
			).toBe(true);
			expect(
				await h
					.db()
					.selectFrom("design_model_steps")
					.select("step_key")
					.where("event_kind", "=", "completed")
					.execute(),
			).toHaveLength(batchCount);
			// Current translations, including those awaiting review, are not translated again.
			const noopCall = { ...call, toolCallId: "translate-again" };
			const noop = await session.write(noopCall, (ctx) =>
				translateLanguage(ctx, target, run()),
			);
			expect(noop).toMatchObject({ ok: true, translated: 0 });
			const borrower = Object.values(source.fields).find(
				(field) => field.id === "borrower",
			);
			if (!borrower) throw new Error("Missing borrower field");
			expect(
				await session.shared(
					{
						toolName: "editField",
						toolCallId: "clarify-borrower",
						input: {
							fieldUuid: borrower.uuid,
							updates: { label: "Borrower's full name" },
						},
					},
					"architect",
				),
			).toMatchObject({ ok: true });
			const revised = (await session.snapshot()).doc;
			expect(
				collectLocalizedTranslationUnits(revised, tag).filter(
					(unit) => unit.status === "out-of-date",
				),
			).toHaveLength(1);
			// Receipt replay must precede looking at the changed source, including after reopening.
			session = new AuthoringSession(
				authority,
				f.claim.proposedAppId,
				() => {},
			);
			await session.initialize();
			expect(
				await session.write(noopCall, (ctx) =>
					translateLanguage(ctx, target, run()),
				),
			).toEqual(noop);
			expect((await session.snapshot()).doc).toEqual(revised);
			expect(requests).toHaveLength(batchCount);
			expect(
				await session.write(
					{ ...call, toolCallId: "translate-revised-source" },
					(ctx) => translateLanguage(ctx, target, run()),
				),
			).toMatchObject({ ok: true, translated: 1 });
			expect(requests).toHaveLength(batchCount + 1);
			const fresh = collectLocalizedTranslationUnits(
				(await session.snapshot()).doc,
				tag,
			);
			expect(fresh.filter((unit) => unit.status === "out-of-date")).toEqual([]);
			expect(
				fresh.find(
					(unit) =>
						unit.context.fieldId === "borrower" && unit.role === "field-label",
				)?.effective,
			).toMatchObject({
				parts: [{ kind: "text", text: "Français Borrower's full name" }],
			});
		},
	);
	expect(failures).toEqual([]);
});

it.each([false, true])(
	"validates protected references before any translation is staged (corrected: %s)",
	async (corrected) => {
		const f = await fixture();
		const source = (await f.session.snapshot()).doc;
		let invalidResponses = 0;
		const requests: ProviderRequest[] = [];
		const failures: unknown[] = [];
		await withResponsesPeer(
			(request, response) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					try {
						const wire: ProviderRequest = JSON.parse(
							Buffer.concat(chunks).toString(),
						);
						requests.push(wire);
						const batch = requestBatch(wire);
						const invalid =
							batch.units.some((unit) => unit.protectedTokens.length > 0) &&
							(!corrected || invalidResponses === 0);
						if (invalid) invalidResponses++;
						respondWithParts(
							response,
							[
								{
									type: "text",
									text: JSON.stringify({
										translations: batch.units.map((unit) => ({
											unitId: unit.unitId,
											translatedText:
												invalid && unit.protectedTokens.length
													? "Référence perdue"
													: `Français ${unit.sourceText}`,
										})),
									}),
								},
							],
							requests.length,
						);
					} catch (error) {
						failures.push(error);
						response.writeHead(400).end();
					}
				});
			},
			async (provider) => {
				const result = await f.session.write(call, (ctx) =>
					translateLanguage(ctx, target, {
						designSessionId: f.claim.designSessionId,
						authority: {
							actorUserId: f.authority.actorUserId,
							expectedProjectId: f.authority.projectId,
							runId: f.authority.runId,
							holderNonce: f.authority.holderNonce,
						},
						signal: new AbortController().signal,
						modelStep: productionModelStep(
							provider(MODEL_ROLES.translator.modelId),
							MODEL_ROLES.translator.reasoningEffort,
							"translation-test",
						),
						onStep: async () => {},
						onRecoveredUsage: () => {},
					}),
				);
				if (corrected) {
					expect(result).toMatchObject({ ok: true });
					expect(invalidResponses).toBe(1);
				} else {
					expect(result).toMatchObject({
						error: expect.stringContaining("exactly once"),
					});
					expect(invalidResponses).toBe(3);
					expect((await f.session.snapshot()).doc).toEqual(source);
				}
			},
		);
		expect(failures).toEqual([]);
	},
);
