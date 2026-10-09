// What Web Apps shows a worker now, read from the page the client rendered
// (HQ's cloudcare templates, filled by the client's own views): the screen's
// kind and each part of it a register entry or finding speaks of. Nothing
// here asks the client's code for anything: every value is the document's.
//
// Text is the element's own, with runs of ASCII white space made one space
// and the ends trimmed (`text`); a non-breaking space is kept, since
// CommCare's app strings write one for an empty text. Where a finding turns
// on the exact text, the value is the element's markup as it stands
// (`html`).
//
// - `route`: the client's route (the URL's fragment), parsed where it is JSON.
// - `apps`: the home screen's tiles, each `{name, kind, icon}`; `kind` is
//   what the tile's class names (default for an app, incomplete, sync,
//   settings, restore-as) and `icon` the app's own image, the URL the client
//   gave it, or null for the client's own flower.
// - `commands`: a menu's rows, each `{text, icon, image, badge}`.
// - `list`: a case list. `tiles` says which of the client's two layouts
//   it used. `headers` are the table's column headers as shown, `rows`
//   each case's shown cells (for a tile, every cell with whether the
//   browser lays its content out), `empty` the empty-list message's markup
//   and whether the browser shows its box, `sort` the tile layout's sort
//   choices, `actions` the list's action buttons, `search` whether the
//   client offers its search box, and `cells` the first tile's cells as the
//   browser lays them out: the grid area, alignment and font size it
//   computed from the style element the client wrote under HQ's
//   stylesheets.
// - `query`: a search screen: its title, its description element (null when
//   the client rendered none) and each prompt.
// - `detail`: the case detail dialog, where it is open: each tab's title
//   (and which is active) and each row's header and value as shown.
// - `form`: a form's title and each question's label, whether it is
//   required, the answer its widget shows (a text box's text, the labels of
//   the options checked, a drop-down's chosen text) and the error the client
//   shows for it.
// - `alerts`: what the client's notification region shows.
(_arg) => {
	const text = (element) =>
		element
			? element.textContent.replace(/[ \t\r\n\f]+/g, " ").replace(/^ | $/g, "")
			: null;
	const all = (root, selector) =>
		root ? [...root.querySelectorAll(selector)] : [];
	const one = (root, selector) => (root ? root.querySelector(selector) : null);
	// Whether the browser lays the element out at all under HQ's stylesheets
	// (an element or an ancestor with `display: none` has no box).
	const visible = (element) =>
		element !== null &&
		element.getClientRects().length > 0 &&
		getComputedStyle(element).visibility !== "hidden";
	const background = (element) => {
		const image = element?.style?.backgroundImage ?? "";
		const match = /^url\(["']?(.*?)["']?\)$/.exec(image);
		return match ? match[1] : null;
	};
	const computed = (element) => {
		const style = getComputedStyle(element);
		return {
			gridArea: [
				style.gridRowStart,
				style.gridColumnStart,
				style.gridRowEnd,
				style.gridColumnEnd,
			].join(" / "),
			textAlign: style.textAlign,
			justifySelf: style.justifySelf,
			alignSelf: style.alignSelf,
			fontSize: style.fontSize,
		};
	};
	const menu = document.querySelector("#menu-region");
	const screen = {};

	const fragment = decodeURIComponent(location.hash.replace(/^#/, ""));
	try {
		screen.route = JSON.parse(fragment);
	} catch {
		screen.route = fragment;
	}
	screen.title = text(one(menu, ".page-title"));
	screen.breadcrumbs = all(document, "#breadcrumb-region .breadcrumb-item").map(
		text,
	);

	const apps = all(menu, ".appicon");
	if (apps.length) {
		screen.apps = apps.map((tile) => ({
			name: text(one(tile, "h3")),
			kind:
				[...tile.classList]
					.find((name) => name.startsWith("appicon-"))
					?.slice("appicon-".length) ?? null,
			icon: background(one(tile, ".appicon-custom")),
		}));
	}

	const commands = all(menu, ".menus-container > tr");
	if (one(menu, ".module-menu-container")) {
		screen.commands = commands.map((row) => ({
			text: text(one(row, ".module-column-name")),
			icon:
				[...(one(row, "i.module-icon")?.classList ?? [])].find(
					(name) => name.startsWith("fa-") && name !== "fa-solid",
				) ?? null,
			image: background(one(row, ".module-icon-image")),
			badge: text(one(row, "#module-badge")),
		}));
	}

	const list = one(menu, ".module-case-list-container");
	if (list) {
		const tiles = one(list, ".list-cell-container-style") !== null;
		const empty = one(list, ".module-case-list-column-empty .alert");
		const rows = all(list, ".js-case-container > *");
		screen.list = {
			tiles,
			search: one(list, "#searchText") !== null,
			headers: all(list, "th.module-case-list-header").map((header) => ({
				text: text(header),
				sortable: header.classList.contains("header-clickable"),
			})),
			rows: rows.map((row) => ({
				id: row.id || null,
				cells: tiles
					? all(row, ".box").map((cell) => ({
							text: text(cell),
							hidden: !visible(cell.firstElementChild ?? cell),
						}))
					: all(row, "td.module-case-list-column").map((cell) => ({
							text: text(cell),
							image: one(cell, "img")?.getAttribute("src") ?? null,
						})),
			})),
			empty: empty
				? {
						html: empty.innerHTML,
						text: empty.textContent,
						visible: visible(empty),
					}
				: null,
			sort: all(list, "#case-list-search-controls .dropdown-menu li").map(text),
			actions: all(list, ".case-list-action-button button").map(text),
			cells:
				tiles && rows.length
					? all(rows[0], ".box").map((cell) => ({
							class: [...cell.classList].find((name) =>
								/-grid-style-\d+$/.test(name),
							),
							...computed(cell),
						}))
					: [],
			pages: all(list, ".pagination .page-item").length,
		};
	}

	const query = one(document, "#query-list-contents");
	if (query) {
		// The description sits in the search form, or, where the client lays
		// the search out beside its results, in the results' header.
		const description = one(document, "#cloudcare-main .query-description");
		screen.query = {
			title: text(one(query, "form > h2")),
			description: description
				? {
						html: description.innerHTML,
						text: description.textContent,
						visible: visible(description),
					}
				: null,
			prompts: all(query, "#query-properties > tr").map((row) => ({
				label: text(one(row, ".query-caption label")),
				required:
					one(row, ".query-caption")?.classList.contains("required") ?? false,
				hint: one(row, ".hq-help a")?.getAttribute("data-bs-content") ?? null,
				error: text(one(row, ".invalid-feedback, .has-error")),
			})),
			buttons: all(query, "form button[id]").map((button) => button.id),
		};
	}

	const dialog = one(document, "#case-detail-modal");
	if (dialog?.classList.contains("show")) {
		screen.detail = {
			tabs: all(dialog, ".js-detail-tabs .nav-link").map((tab) => ({
				title: text(tab),
				active: tab.classList.contains("active"),
			})),
			rows: all(dialog, ".js-detail-content tr").map((row) => ({
				header: text(one(row, "th")),
				value: text(one(row, "td")),
			})),
			buttons: all(dialog, ".js-detail-footer-content button").map(text),
		};
	}

	const shownAnswer = (question) => {
		const widget = one(question, ".widget");
		if (!widget) return null;
		const checked = all(widget, "input.form-check-input:checked");
		if (checked.length) {
			return checked.map((input) =>
				text(widget.querySelector(`label[for="${input.id}"]`)),
			);
		}
		const select = one(widget, "select.form-select");
		if (select) return select.selectedOptions[0]?.textContent ?? null;
		const box = one(
			widget,
			"textarea.textfield, input.form-control[type=text], input.form-control[type=password]",
		);
		return box ? box.value : null;
	};
	const form = one(document, "#webforms");
	if (form?.children.length) {
		screen.form = {
			title: text(one(form, ".form-container h1, h1.title")),
			questions: all(form, ".q").map((question) => ({
				label: text(one(question, ".caption, legend, label")),
				required: one(question, ".required") !== null,
				answer: shownAnswer(question),
				errors: all(question, ".error-message").filter(visible).map(text),
			})),
			submit: text(one(form, "button.submit")),
		};
	}

	screen.alerts = all(
		document,
		"#cloudcare-notifications .alert, #hq-messages-container .alert",
	).map(text);
	screen.version = text(document.querySelector("#version-info"));
	return screen;
};
