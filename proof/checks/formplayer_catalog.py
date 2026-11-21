"""Account for the local CCZ's stated fallback where Formplayer publishes a catalog translation."""

import re
from functools import cache

from lxml import etree

from proof.checks.changes import unescaped
from proof.checks.compare.app_strings import catalog_strings, parse_app_strings
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.served_places import form_namespaces

# BaseResponseBean.populateTranslations consults the runtime for exactly these keys, adding a row only
# for a non-null answer. Submit labels are form-authored and reach the response by a different path.
KEYS = frozenset({"repeat.dialog.add.new", "upload.clear.title"})
ADVISORY = "kept_ui_text_falls_back"
# The wire code of a language admitted by lib/domain/localization.ts, used in the upstream catalog filename.
LANGUAGE = re.compile(r"[a-z]{2,3}(?:-[a-z]*)?")


def _read(trace, run, step, namespaces):
    runs = trace.get("runs") or []
    if run >= len(runs):
        return None, None
    steps = runs[run].get("steps") or []
    if step >= len(steps):
        return None, None
    response = steps[step].get("response") or {}
    if not (response.get("instanceXml") or {}).get("output") or not isinstance(response.get("translations"), dict):
        return None, None
    # Walk._web starts each run in trace.locale. A worker's language change records the new locale at navigation.
    locale = next(
        (s["request"]["locale"] for s in reversed(steps[: step + 1]) if "locale" in (s.get("request") or {})),
        trace.get("locale"),
    )
    try:
        namespace = etree.QName(parse_xml(response["instanceXml"]["output"])).namespace
    except XmlNotWellFormed:
        return None, None
    position = namespaces.get(namespace)
    selections = response.get("selections")
    if not position or not isinstance(locale, str) or not isinstance(selections, list):
        return None, None
    return (locale, position, selections), response["translations"]


def _pointer(d):
    if (
        d.artifact != "formplayer@local.ccz"
        or d.path != "/runs/*/steps/*/response/translations/*"
        or d.kind != "removed"
    ):
        return None
    p = unescaped(d.at)
    if (
        len(p) == 7
        and p[0] == "runs"
        and p[1].isdigit()
        and p[2] == "steps"
        and p[3].isdigit()
        and p[4:6] == ["response", "translations"]
        and p[6] in KEYS
    ):
        return int(p[1]), int(p[3]), p[6]
    return None


def unstated(rows, *, advisory, source, target, hq_files, local_files, baseline, local, release_differs=None):
    """Leave every difference except an announced switch from HQ catalog text to the device's built-in wording.

    HQ's select-known build selects keys across *all* stored language tables, including an inactive language.
    Check its pinned translation loader for the app's build version and the actual release files. The local
    handoff only installs Android fallback keys required by a named language; with the key absent from all
    these files its Formplayer lookup returns null. Android installs its own base catalog before the app's.
    """
    if (
        advisory != ADVISORY
        or not source
        or not target
        or source.get("translation_strategy") != "select-known"
        or release_differs
        or not local_files
        or not hq_files
        or not any(_pointer(d) for d in rows)
    ):
        return rows
    from proof.core.client import ANDROID_DEFAULT_STRINGS

    tables = [app.get("translations") or {} for app in (source, target)]
    codes = source.get("langs") or []
    version = (source.get("build_spec") or {}).get("version")
    if (
        not isinstance(codes, list)
        or codes != target.get("langs")
        or not all(isinstance(code, str) and LANGUAGE.fullmatch(code) for code in codes)
        or not all(isinstance(t, dict) for t in tables)
    ):
        return rows

    @cache
    def table(side, code):
        content = (hq_files if side == "hq" else local_files).get(f"{code}/app_strings.txt")
        return None if content is None else parse_app_strings(content)

    @cache
    def expected(code, key):
        if code not in codes or not all(
            any(isinstance(t, dict) and key in t for t in by_lang.values()) for by_lang in tables
        ):
            return None
        # No explicit language of the app may lose its own value. A key in an inactive table or a
        # stored empty string selects the catalog just as a key with an active override does.
        if any((by_lang.get(lang) or {}).get(key) not in (None, "") for by_lang in tables for lang in codes):
            return None
        named = [table("hq", lang) for lang in codes]
        catalogs = [stock(lang).get(key) for lang in codes]
        if any(t is None or t.get(key) != text for t, text in zip(named, catalogs, strict=True)):
            return None
        # HQ's default merge takes the first nonempty text in active language order.
        default = table("hq", "default")
        fallback = next((text for text in catalogs if text), None)
        if not fallback or default is None or default.get(key) != fallback:
            return None
        # A named key also asks the local served archive to add an Android fallback to default. Check every
        # local language file, including any unexpected one, since that is how the handoff selects its rows.
        local_codes = {
            name.split("/")[0] for name in local_files if name.count("/") == 1 and name.endswith("/app_strings.txt")
        }
        if not {"default", *codes} <= local_codes or any(key in table("local", lang) for lang in local_codes):
            return None
        if not android_stock().get(key):
            return None
        return stock(code).get(key) or fallback

    @cache
    def stock(code):
        return catalog_strings(code, version)

    @cache
    def android_stock():
        return parse_app_strings(ANDROID_DEFAULT_STRINGS.read_bytes())

    hq_forms, local_forms = form_namespaces(hq_files), form_namespaces(local_files)

    def stated(d):
        pointer = _pointer(d)
        if pointer is None:
            return False
        run, step, key = pointer
        opened, hq_values = _read(baseline, run, step, hq_forms)
        other, local_values = _read(local, run, step, local_forms)
        return (
            opened is not None
            and opened == other
            and hq_values is not None
            and local_values is not None
            and key not in local_values
            and isinstance(d.before, str)
            and d.after is None
            and hq_values.get(key) == d.before == expected(opened[0], key)
        )

    return [d for d in rows if not stated(d)]
