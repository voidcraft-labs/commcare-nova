import { describe, expect, it } from "vitest";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import { extractDocument, extractDocumentSchema } from "../documentExtraction";
import { makeTestContext } from "./fixtures";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

const OBJECT = {
	title: "Visit requirements",
	summary: "Collect visit results.",
	extract: "## Visit\n\n- Date\n- Result",
};
const model = MODEL_ROLES.documentExtractor;
const opts = {
	schema: extractDocumentSchema,
	system: "Extract requirements",
	prompt: "Visit date and result",
	label: "visit.txt",
	model: model.modelId,
	providerOptions: reasoningProviderOptions(model.reasoningEffort),
};

describe("GenerationContext document extraction with the real SDK", () => {
	it.each(["text", "pdf"] as const)(
		"runs the actual %s extraction schema and meters one provider response",
		async (kind) => {
			const received = Promise.withResolvers<{
				model: string;
				input: unknown[];
				text: { format: { schema: { required: string[] } } };
			}>();
			await withResponsesPeer(
				(request, response) => {
					let body = "";
					request.setEncoding("utf8");
					request.on("data", (chunk) => {
						body += chunk;
					});
					request.on("end", () => {
						received.resolve(JSON.parse(body));
						respondWithObject(response, JSON.stringify(OBJECT));
					});
				},
				async (_provider, transport) => {
					const { ctx, usage, writer, logWriter } = makeTestContext({
						transport,
					});
					const bytes = Buffer.from(
						kind === "pdf"
							? "%PDF-1.7\nlocal fixture"
							: "Visit date and result",
					);
					const out = await extractDocument({
						bytes,
						mimeType: kind === "pdf" ? "application/pdf" : "text/plain",
						kind,
						filename: `visit.${kind === "pdf" ? "pdf" : "txt"}`,
						condenser: ctx,
					});
					expect(out).toEqual({ ...OBJECT, truncated: false });
					expect(usage.snapshot()).toMatchObject({
						inputTokens: 11,
						outputTokens: 7,
						stepCount: 0,
					});
					expect(writer.write).not.toHaveBeenCalled();
					expect(logWriter.logEvent).not.toHaveBeenCalled();
					const request = await received.promise;
					expect(request.model).toBe(model.modelId);
					expect(request.text.format.schema.required).toEqual([
						"title",
						"summary",
						"extract",
					]);
					expect(request.input).toContainEqual({
						role: "user",
						content:
							kind === "pdf"
								? [
										{
											type: "input_text",
											text: "Extract every requirement from this document. Filename: visit.pdf.",
										},
										{
											type: "input_file",
											filename: "part-1.pdf",
											file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
										},
									]
								: [
										{
											type: "input_text",
											text: "Filename: visit.txt\n\nVisit date and result",
										},
									],
					});
				},
			);
		},
	);

	it("returns a null truncated result and retains usage when native JSON stops mid-object", async () => {
		await withResponsesPeer(
			(_request, response) =>
				respondWithObject(response, '{"title":"Visit', { incomplete: true }),
			async (_provider, transport) => {
				const { ctx, usage } = makeTestContext({ transport });
				expect(await ctx.extractDocumentStructured(opts)).toEqual({
					object: null,
					truncated: true,
				});
				expect(usage.snapshot()).toMatchObject({
					inputTokens: 11,
					outputTokens: 7,
					stepCount: 0,
				});
			},
		);
	});

	it("refuses an explicitly incomplete response even when its JSON happens to parse", async () => {
		await withResponsesPeer(
			(_request, response) =>
				respondWithObject(response, JSON.stringify(OBJECT), {
					incomplete: true,
				}),
			async (_provider, transport) => {
				const { ctx, usage } = makeTestContext({ transport });
				await expect(
					extractDocument({
						bytes: Buffer.from("Visit requirements"),
						mimeType: "text/plain",
						kind: "text",
						filename: "visit.txt",
						condenser: ctx,
					}),
				).rejects.toThrow(/output ceiling/);
				expect(usage.snapshot()).toMatchObject({
					inputTokens: 11,
					outputTokens: 7,
				});
			},
		);
	});

	it.each([true, false])(
		"propagates the native refusal with emitErrors=%s",
		async (emitErrors) => {
			await withResponsesPeer(
				(_request, response) => {
					response.writeHead(401, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							error: {
								message: "Invalid API key",
								type: "invalid_request_error",
								code: "invalid_api_key",
							},
						}),
					);
				},
				async (_provider, transport) => {
					const { ctx, usage, writer, logWriter } = makeTestContext({
						transport,
					});
					await expect(
						ctx.extractDocumentStructured({ ...opts, emitErrors }),
					).rejects.toMatchObject({ statusCode: 401 });
					expect(usage.snapshot()).toMatchObject({
						inputTokens: 0,
						outputTokens: 0,
					});
					if (emitErrors) {
						expect(writer.write).toHaveBeenCalledExactlyOnceWith(
							expect.objectContaining({
								type: "data-conversation-event",
								data: expect.objectContaining({
									payload: {
										type: "error",
										error: expect.objectContaining({ type: "api_auth" }),
									},
								}),
							}),
						);
						expect(logWriter.logEvent).toHaveBeenCalledOnce();
					} else {
						expect(writer.write).not.toHaveBeenCalled();
						expect(logWriter.logEvent).not.toHaveBeenCalled();
					}
				},
			);
		},
	);
});

it.each([
	String.raw`Match \n with \d{3}`,
	String.raw`# Paths: C:\new\files and C:\temp`,
	String.raw`## Rule\n- Keep this literal sequence`,
])(
	"preserves typed extract data without guessing a second escape layer: %s",
	async (extract) => {
		await withResponsesPeer(
			(_request, response) =>
				respondWithObject(response, JSON.stringify({ ...OBJECT, extract })),
			async (_provider, transport) => {
				const { ctx } = makeTestContext({ transport });
				const result = await extractDocument({
					bytes: Buffer.from("Literal syntax requirements"),
					mimeType: "text/plain",
					kind: "text",
					filename: "syntax.txt",
					condenser: ctx,
				});
				expect(result.extract).toBe(extract);
			},
		);
	},
);
