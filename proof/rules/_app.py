"""What the app-document rules read of HQ's app JSON: its modules, forms and details.

A private helper of the rule modules (``proof.rules.unregistered_rules``
reads a module whose name starts with ``_`` as no rule). Nothing here
changes an app.
"""

from __future__ import annotations

# The details of a module whose columns and sort elements HQ builds into the suite (``models/modules.py``,
# ``Module.case_details``; a module without case details has none).
DETAIL_DISPLAYS = ("short", "long")


def modules(app):
    """Every module of the app document, as a dict."""
    if not isinstance(app, dict):
        return []
    return [module for module in app.get("modules") or [] if isinstance(module, dict)]


def forms(module):
    """Every form of a module, as a dict."""
    return [form for form in module.get("forms") or [] if isinstance(form, dict)]


def case_details(module):
    """The module's case list (``short``) and case detail (``long``) where it has them."""
    details = module.get("case_details")
    if not isinstance(details, dict):
        return []
    return [details[display] for display in DETAIL_DISPLAYS if isinstance(details.get(display), dict)]


def all_blank(mapping):
    """Whether a language map holds no text: empty, or every value ``""``."""
    return isinstance(mapping, dict) and all(value == "" for value in mapping.values())


def blank_to_empty(holder, key):
    """``holder[key]`` made ``{}`` where it is a language map that holds no text (``all_blank``)."""
    if isinstance(holder, dict) and all_blank(holder.get(key)):
        holder[key] = {}
