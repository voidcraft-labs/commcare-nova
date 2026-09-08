import type { Page } from "@playwright/test";
import { z } from "zod";
import {
	appLocalizationSchema,
	makeTranslationUnitId,
	proseTemplateSchema,
	proseText,
} from "@/lib/domain";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { LOCALIZATION_SEED } from "../../lib/localizationSeed";
import { replaceRichText } from "../../lib/richText";

const snapshotSchema = z.object({
	blueprint: z.object({
		fields: z.record(
			z.string(),
			z.object({
				id: z.string(),
				label: proseTemplateSchema,
				hint: proseTemplateSchema.optional(),
			}),
		),
		localization: appLocalizationSchema.optional(),
	}),
});

function nextSave(page: Page, appId: string) {
	return page.waitForResponse(
		(response) =>
			response.request().method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${appId}`,
	);
}

async function selectLanguage(page: Page, name: string) {
	await page.getByRole("button", { name: /^Worker language:/ }).click();
	await page.getByRole("menuitemradio", { name, exact: true }).click();
}

test(
	"language edits preserve source content and the URL lens across Builder, reload and Preview",
	{ tag: "@seed:localization" },
	async ({ scenario, page, baseURL }, _testInfo) => {
		const seed = seedFor(scenario, "localization");

		const appId = seed.localizationAppId;
		if (!appId) throw new Error("Missing language app for this attempt");
		const setupPath = `/build/${appId}/setup/languages`;
		await page.goto(setupPath);
		await page
			.getByRole("button", { name: "Add language", exact: true })
			.click();
		const dialog = page.getByRole("dialog");
		await dialog
			.getByRole("combobox", { name: "Language", exact: true })
			.fill("Spanish");
		await page.getByRole("option", { name: /Español/ }).click();
		const languageSaved = nextSave(page, appId);
		await dialog
			.getByRole("button", { name: "Add language", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Español phrases" }),
		).toBeVisible();
		expect((await languageSaved).status()).toBe(200);
		await expect(page).toHaveURL(`${setupPath}?lang=spa`);

		const hint = page.getByRole("article").filter({ hasText: "Field hint" });
		const draft = hint.getByRole("textbox", {
			name: "Reference-safe translation",
		});
		await expect(draft).toHaveValue("Worker [[NOVA_REF_1]]");
		await draft.fill("Trabajador");
		await expect(hint.getByRole("alert")).toHaveText(
			"Keep [[NOVA_REF_1]] exactly once.",
		);
		await expect(
			hint.getByRole("button", { name: "Save translation" }),
		).toBeDisabled();
		await draft.fill("Trabajador [[NOVA_REF_1]]");
		const hintSaved = nextSave(page, appId);
		await hint.getByRole("button", { name: "Save translation" }).click();
		expect((await hintSaved).status()).toBe(200);
		await hint.getByRole("button", { name: "Open in Builder" }).click();
		await expect(page).toHaveURL(
			new RegExp(`/build/${appId}/${LOCALIZATION_SEED.fieldUuid}\\?lang=spa$`),
		);

		// The ordinary canvas editor must lower this edit to the Spanish overlay.
		const field = page.getByRole("button", {
			name: "Select field",
			exact: true,
		});
		await field
			.getByRole("button", { name: "Client name", exact: true })
			.click();
		const inline = field.locator('[contenteditable="true"]');
		await expect(inline).toBeFocused();
		await replaceRichText(inline, "Nombre del cliente");
		const labelSaved = nextSave(page, appId);
		await inline.press("ControlOrMeta+Enter");
		expect((await labelSaved).status()).toBe(200);
		await expect(
			field.getByRole("button", { name: "Nombre del cliente", exact: true }),
		).toBeVisible();

		await page.reload();
		await expect(
			page.getByRole("button", { name: "Worker language: Spanish" }),
		).toBeVisible();
		await expect(
			field.getByRole("button", { name: "Nombre del cliente", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const answer = page.getByRole("textbox", { name: /Nombre del cliente$/ });
		await answer.fill("Asha");
		await selectLanguage(page, "English");
		await expect(
			page.getByRole("textbox", { name: /Client name$/ }),
		).toHaveValue("Asha");
		await selectLanguage(page, "Español");
		await expect(answer).toHaveValue("Asha");
		await page
			.getByRole("button", { name: "Back to edit", exact: true })
			.click();

		const response = await page.request.get(`/api/apps/${appId}`);
		expect(response.status()).toBe(200);
		const { blueprint } = snapshotSchema.parse(await response.json());
		expect(blueprint.fields[LOCALIZATION_SEED.fieldUuid]).toEqual({
			id: "client_name",
			label: proseText("Client name"),
			hint: {
				parts: [
					{ kind: "text", text: "Worker " },
					{ kind: "user-ref", property: "username" },
				],
			},
		});
		expect(blueprint.localization?.translations.spa).toMatchObject({
			[makeTranslationUnitId("field", LOCALIZATION_SEED.fieldUuid, "label")]: {
				value: proseText("Nombre del cliente"),
				origin: "human",
				review: "reviewed",
			},
			[makeTranslationUnitId("field", LOCALIZATION_SEED.fieldUuid, "hint")]: {
				value: {
					parts: [
						{ kind: "text", text: "Trabajador " },
						{ kind: "user-ref", property: "username" },
					],
				},
				origin: "human",
				review: "reviewed",
			},
		});

		await page
			.getByRole("button", { name: "Worker language: Spanish" })
			.click();
		await page.getByRole("menuitem", { name: "Manage languages" }).click();
		const peer = await page.context().newPage();
		const peerGuard = await attachErrorGuard(peer, baseURL);
		try {
			await peer.goto(`${setupPath}?lang=spa`);
			await draft.fill("Borrador [[NOVA_REF_1]]");
			const peerHint = peer
				.getByRole("article")
				.filter({ hasText: "Field hint" });
			await peerHint
				.getByRole("textbox", { name: "Reference-safe translation" })
				.fill("Colaborador [[NOVA_REF_1]]");
			const peerSaved = nextSave(peer, appId);
			await peerHint.getByRole("button", { name: "Save translation" }).click();
			expect((await peerSaved).status()).toBe(200);
			await expect(draft).toHaveValue("Colaborador [[NOVA_REF_1]]");

			// The other tab removes the language while it is selected as a copy
			// source in an open dialog. Both the language lens and copy source must
			// reconcile from the same incoming document, without a refresh.
			await page
				.getByRole("button", { name: "Add language", exact: true })
				.click();
			const copyFrom = dialog.getByRole("combobox", { name: "Copy text from" });
			await copyFrom.click();
			await page.getByRole("option", { name: /Español/ }).click();
			await expect(copyFrom).toContainText("Español");
			await peer.getByRole("button", { name: "Remove", exact: true }).click();
			const removed = nextSave(peer, appId);
			await peer
				.getByRole("button", { name: "Remove language", exact: true })
				.click();
			expect((await removed).status()).toBe(200);
			await expect(copyFrom).toContainText("English");
			await dialog.press("Escape");
			await expect(
				page.getByRole("heading", { name: "English phrases" }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Worker language: English" }),
			).toBeVisible();
			await closePageWithUnload(peer);
			await peerGuard.assertNoErrors();
		} finally {
			await closePageWithUnload(peer);
		}
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "English phrases" }),
		).toBeVisible();
	},
);
