/**
 * Nova's wording for fumadocs' own UI strings.
 *
 * The library ships Title Case ("Collapse Sidebar", "Open Search", "Copy
 * Anchor Link", "Next Page"), and Nova writes everything in sentence case.
 * These are the library's strings, not ours, so the only place to say so is
 * its translation table. Keys come from
 * `fumadocs-ui/dist/.translations/keys.json`; the parenthetical suffix is
 * part of the key, not part of what a person reads.
 *
 * Only entries that actually differ are listed. Anything absent falls
 * through to the library's default, which is already sentence case.
 */
import { defineTranslations } from "fumadocs-core/i18n";
import { uiTranslations } from "fumadocs-ui/i18n";

export const docsTranslations = defineTranslations()
	.extend(uiTranslations())
	.add({
		"Back to Home(404 page)": "Back to docs",
		"Close Banner(banner)(aria-label)": "Close banner",
		"Close Search(search dialog)(aria-label)": "Close search",
		"Close Sidebar(sidebar)(aria-label)": "Close sidebar",
		"Collapse Sidebar(sidebar)(aria-label)": "Collapse sidebar",
		"Copied Text(code block)(aria-label)": "Copied",
		"Copy Anchor Link(heading anchor)(aria-label)": "Copy link to this heading",
		"Copy Link(accordion)(aria-label)": "Copy link",
		"Copy Markdown(page actions)": "Copy markdown",
		"Copy Text(code block)(aria-label)": "Copy",
		"Dark(theme switcher)(aria-label)": "Dark",
		"Edit on GitHub(edit page)": "Edit on GitHub",
		"Light(theme switcher)(aria-label)": "Light",
		"Next Page(pagination)": "Next page",
		"No Headings(table of contents)": "No headings",
		"Open Search(search trigger)(aria-label)": "Open search",
		"Open Sidebar(sidebar)(aria-label)": "Open sidebar",
		"Page Not Found(404 page)": "Page not found",
		"Previous Page(pagination)": "Previous page",
		"System(theme switcher)(aria-label)": "System",
		"Table of Contents(inline table of contents)": "Table of contents",
		"Toggle Menu(mobile menu)(aria-label)": "Toggle menu",
		"Toggle Theme(theme switcher)(aria-label)": "Toggle theme",
		"View as Markdown(page actions)": "View as markdown",
	});
