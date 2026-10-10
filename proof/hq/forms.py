"""A form HQ's page draws, as a person's browser posts it.

HQ draws a page's form with the form's own class and crispy helper
(``{% crispy form %}``), and what a browser sends when a person submits it is
the form's entry list (HTML's "constructing the entry list"): each named
control the form holds that is not disabled, in the order the form holds
them; a check box or a radio button only where it is checked, with its value
("on" where it names none); each selected option of a select, and a select of
one value none of whose options is selected sends its first; a text area's
text; any other input's value; and no button, since the page's Save names
none. ``posted`` draws the form as the page draws it
(``crispy_forms.utils.render_crispy_form`` with the form's own helper and the
page's CSRF token) and reads that list from the markup with lxml, with what a
person typed or chose in place of a control's own value. A value given for a
control the form does not draw raises, since no browser would send it, and so
does a choice a select does not offer.
"""

from __future__ import annotations


class NotDrawn(AssertionError):
    """A person was given a value for a control HQ's form does not draw, or a choice it does not offer."""


def posted(form, typed: dict, csrf_token: str) -> list[tuple[str, str]]:
    """The entry list a browser posts for ``form`` as HQ's page draws it, with ``typed`` (each control's name to
    the text typed into it, the value chosen of a select or radio button, or whether a check box is ticked) in
    place of what the form draws, and the page's ``csrf_token`` in the hidden input HQ's template draws for it."""
    from crispy_forms.utils import render_crispy_form
    from lxml import html

    markup = render_crispy_form(form, helper=getattr(form, "helper", None), context={"csrf_token": csrf_token})
    root = html.fragment_fromstring(markup, create_parent="div")
    forms = root.findall(".//form")
    if len(forms) != 1:
        raise NotDrawn(f"HQ's helper drew {len(forms)} forms for {type(form).__name__}, where a page holds one.")
    entries: list[tuple[str, str]] = []
    drawn: set[str] = set()
    for control in forms[0].iter("input", "select", "textarea", "button"):
        name = control.get("name")
        if not name or control.get("disabled") is not None or _in_disabled_fieldset(control):
            continue
        drawn.add(name)
        given = typed.get(name, _UNTOUCHED)
        if control.tag == "button":
            continue
        if control.tag == "textarea":
            entries.append((name, (control.text or "") if given is _UNTOUCHED else str(given)))
        elif control.tag == "select":
            entries.extend((name, value) for value in _selected(control, given))
        else:
            kind = (control.get("type") or "text").lower()
            if kind in ("submit", "button", "reset", "image", "file"):
                continue
            if kind in ("checkbox", "radio"):
                value = control.get("value", "on")
                if kind == "checkbox":
                    checked = control.get("checked") is not None if given is _UNTOUCHED else bool(given)
                else:
                    checked = control.get("checked") is not None if given is _UNTOUCHED else str(given) == value
                if checked:
                    entries.append((name, value))
            else:
                entries.append((name, control.get("value", "") if given is _UNTOUCHED else str(given)))
    missing = sorted(set(typed) - drawn)
    if missing:
        raise NotDrawn(
            f"A person was to fill {missing} on HQ's {type(form).__name__}, and the form HQ draws holds no such"
            f" control (it draws {sorted(drawn)})."
        )
    return entries


_UNTOUCHED = object()


def _in_disabled_fieldset(control) -> bool:
    return any(parent.tag == "fieldset" and parent.get("disabled") is not None for parent in control.iterancestors())


def _selected(select, given) -> list[str]:
    options = [option for option in select.iter("option") if option.get("disabled") is None]
    values = [option.get("value", option.text_content()) for option in options]
    multiple = select.get("multiple") is not None
    if given is not _UNTOUCHED:
        chosen = [str(value) for value in given] if multiple else [str(given)]
        unoffered = [value for value in chosen if value not in values]
        if unoffered:
            raise NotDrawn(f"The select {select.get('name')} offers {values}, not {unoffered}.")
        return chosen
    selected = [value for option, value in zip(options, values, strict=True) if option.get("selected") is not None]
    if multiple:
        return selected
    return selected[-1:] or values[:1]
