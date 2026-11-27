/**
 * Sentence-case overrides for the UI that Fumadocs renders in Nova's docs.
 * The translation keys name the source text and its component. Nova's 404
 * page owns its own copy.
 */
import { defineTranslations } from "fumadocs-core/i18n";
import { uiTranslations } from "fumadocs-ui/i18n";

export const docsTranslations = defineTranslations()
	.extend(uiTranslations())
	.add({
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
		"Previous Page(pagination)": "Previous page",
		"Search failed(search dialog)":
			"Couldn't search the docs. You can refresh the page to try again.",
		"Search failed, showing results for {query}(search dialog)":
			"Couldn't search the docs. Showing earlier results for {query}.",
		"Skip to Content(skip link)": "Skip to content",
		"System(theme switcher)(aria-label)": "System",
		"Table of Contents(inline table of contents)": "Table of contents",
		"Toggle Theme(theme switcher)(aria-label)": "Toggle theme",
		"View as Markdown(page actions)": "View as markdown",
	});
