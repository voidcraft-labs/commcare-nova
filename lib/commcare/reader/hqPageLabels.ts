/**
 * The labels CommCare HQ's own pages show for a closed word of an app, quoted
 * in a finding's `detail.name` so a person can find the setting there. They
 * are HQ's English, never translated by Nova. A word a table lacks gives no
 * name. The word is the app's, so each table answers only its own entries
 * (`lib/commcare/sourceKeys.ts`).
 */

import { type SourceTable, tableOf } from "../sourceKeys";

/** `static/app_manager/js/details/utils.js`, the format menu. */
export const COLUMN_FORMAT_LABELS: SourceTable<string> = tableOf({
	plain: "Plain",
	date: "Date",
	"time-ago": "Time Since or Until Date",
	phone: "Phone Number",
	enum: "ID Mapping",
	"late-flag": "Late Flag",
	invisible: "Search Only",
	address: "Address",
	distance: "Distance from current location",
	markdown: "Markdown",
	"geo-boundary": "Geo Boundary (Mobile only)",
	"geo-boundary-color": "Geo Boundary Color (Mobile only)",
	"geo-points": "Geo Points (Mobile only)",
	"geo-points-colors": "Geo Points Colors (Mobile only)",
	"address-popup": "Address Popup (Web Apps only)",
	"clickable-icon": "Clickable Icon (Web Apps only)",
	picture: "Picture",
	audio: "Audio",
	"enum-image": "Icon",
	"conditional-enum": "Conditional ID Mapping",
	"translatable-enum": "Translatable Text",
});

/** `views/forms.py::get_form_view_context`, the form settings page's end-of-form menu. */
export const WORKFLOW_LABELS: SourceTable<string> = tableOf({
	default: "Home Screen",
	root: "First Menu",
	module: "Menu",
	parent_module: "Parent Menu",
	previous_screen: "Previous Screen",
	form: "Link to other form or menu",
});
