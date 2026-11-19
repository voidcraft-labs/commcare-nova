"""Two app strings files compared as the maps they hold, reporting every difference.

An app strings file is read by HQ's own reader of the files HQ writes
(``commcare_translations.loads``, which ``app_strings.py`` uses to read them
back): a map from each key to its value, comments dropped. Core reads the
same lines the same way (``LocalizationUtils.parseAndAdd``: comments from an
unescaped ``#`` dropped, key before the first ``=``).

A key's ``at`` is the key itself. Its structural ``path`` is the family HQ
writes it in: HQ registers the format of every app strings key it derives
from the app (``id_strings.py``: each ``@pattern(<format>)``, such as
``forms.m%df%d`` for a form's name, whose regular expressions it keeps in
``id_strings.REGEXES``), and those formats hold the app's positions
(``%d``) and data (``%s``, a case property, a detail type). So the path is
the most specific family the key is in, with each placeholder as ``*``
(``/forms.m*f*``), and one symptom on several forms, or on several
documents, has one path. A key in no family is CommCare's own string id
(a UI translation such as ``home.start``), vocabulary rather than data, and
is its own path.

The comparison runs without HQ (judgment reads records only): HQ's key
families at the pin are kept in ``app_strings_families.json``, written from
HQ's registry (``python -m proof.checks.compare.app_strings`` where HQ is
booted, ``hq_key_families``) and held to it by a test in the image; HQ's
reader is ``commcare_translations``, a module of HQ's checkout that imports
neither HQ nor Django, read from there without booting HQ.
"""

from __future__ import annotations

import json
import os
import re
import sys
from functools import cache
from pathlib import Path

from proof.checks.differences import Difference, pointer_token

FAMILIES_JSON = Path(__file__).with_name("app_strings_families.json")
# Where HQ's checkout keeps its app strings reader.
TRANSLATIONS = Path(os.environ.get("PROOF_HQ", "/opt/hq"), "submodules", "commcare-translations")

# How HQ's ``id_strings._format_to_regex`` writes each placeholder of a format.
_PLACEHOLDERS = ((".*", "%s"), ("[0-9]+", "%d"))


class UnknownKeyFamily(AssertionError):
    """HQ's registry of app strings key formats holds an expression its own format reader did not write."""


def _format_of(regex):
    """The format ``id_strings._format_to_regex`` wrote ``regex`` from, read back character by character."""
    format_, index = [], 0
    while index < len(regex):
        for written, placeholder in _PLACEHOLDERS:
            if regex.startswith(written, index):
                format_.append(placeholder)
                index += len(written)
                break
        else:
            if regex[index] == "\\" and index + 1 < len(regex):
                index += 1
            literal = regex[index]
            format_.append("%%" if literal == "%" else literal)
            index += 1
    return "".join(format_)


def hq_key_families():
    """HQ's app strings key families as ``id_strings`` registers them, read where HQ is booted: [(format, regex)].

    Each format is read back from the expression HQ keeps and checked by
    writing it again with HQ's own ``_format_to_regex``, so a family is
    exactly what HQ registered.
    """
    from corehq.apps.app_manager import id_strings

    families = []
    for regex in dict.fromkeys(id_strings.REGEXES):
        format_ = _format_of(regex)
        if id_strings._format_to_regex(format_) != regex:
            raise UnknownKeyFamily(
                f"HQ's id_strings registers the key expression {regex!r}, which proof/checks/compare/app_strings.py"
                f" reads back as the format {format_!r}, and HQ writes that format as"
                f" {id_strings._format_to_regex(format_)!r}. Teach the reader how HQ now writes its formats."
            )
        families.append((format_, regex))
    return families


def families_json(families):
    """The families file's text, as Biome formats it."""
    written = {"families": [{"format": format_, "regex": regex} for format_, regex in families]}
    return json.dumps(written, indent="\t", ensure_ascii=False) + "\n"


@cache
def key_families():
    """HQ's app strings key families at the pin (``app_strings_families.json``): (format, compiled expression)."""
    written = json.loads(FAMILIES_JSON.read_text(encoding="utf-8"))
    return tuple((family["format"], re.compile(family["regex"])) for family in written["families"])


def _specificity(format_):
    placeholders = format_.count("%s") + format_.count("%d")
    literal = len(format_.replace("%s", "").replace("%d", "").replace("%%", "%"))
    return (-literal, placeholders, format_)


@cache
def key_path(key):
    """The structural path of one app strings key: its most specific HQ family, or the key itself."""
    matching = [format_ for format_, expression in key_families() if expression.fullmatch(key)]
    if not matching:
        return f"/{pointer_token(key)}"
    family = min(matching, key=_specificity)
    return f"/{pointer_token(family.replace('%s', '*').replace('%d', '*').replace('%%', '%'))}"


# The one family HQ registers that a runtime's own catalog names too (``android_translatable_strings.txt``), so a
# stored key of it is the target's (``lib/commcare/appStringKeys.ts``, ``TARGET_OWNED_PATTERN``).
TARGET_OWNED_FAMILY = "android.package.name.%s"
# The characters a locale line's key cannot hold and still be one record of its own name: the line's key ends at the
# first ``=``, a comment starts at ``#``, and the line ends at a line feed or a carriage return.
NOT_IN_A_KEY = frozenset("=#\n\r")


def is_locale_file_key(key):
    """Whether ``key`` is one record of a locale file under its own name (``lib/commcare/localeFile.ts::
    isLocaleFileKey``): not empty, no ``=``, ``#``, line feed or carriage return in it, and no character at either
    end that Java's ``String.trim()`` (every one up to U+0020) or Python's ``str.strip()`` (``str.isspace``)
    removes, so HQ's build (``commcare_translations.dumps``, then ``load``) and Core
    (``LocalizationUtils.parseAndAdd``) both read the line ``key=...`` as defining ``key`` and nothing else."""
    if not key or not NOT_IN_A_KEY.isdisjoint(key):
        return False
    return not any(ord(end) <= 0x20 or end.isspace() for end in (key[0], key[-1]))


def written_key(key):
    """The string a stored ``translations`` key sets in HQ's build, or None where it sets no one string of its own
    name (``lib/commcare/appStringKeys.ts::writtenTranslationKey``): ``dumps`` writes ``key.strip()``, and the line
    is one record under that name only where it is a locale file key (``is_locale_file_key``)."""
    written = key.strip()
    return written if is_locale_file_key(written) else None


def translation_key_owner(key, codes):
    """Who owns one key of an app's ``translations``, by the rule Nova's publish and archive follow
    (``lib/commcare/appStringKeys.ts::translationKeyOwner``), judged on the key as HQ's build writes it, stripped
    (``written_key``): ``not-its-own`` where it sets no one string of its own name; ``generated`` where HQ's
    ``id_strings`` registers a family that matches it at its start, as HQ's ``re.match`` reads one, the package
    name's family aside (``TARGET_OWNED_FAMILY``); ``language-name`` where it is one of ``codes``, the app's
    language codes; ``target`` otherwise."""
    written = written_key(key)
    if written is None:
        return "not-its-own"
    if any(expression.match(written) for format_, expression in key_families() if format_ != TARGET_OWNED_FAMILY):
        return "generated"
    return "language-name" if written in codes else "target"


def is_locale_file_value(value):
    """Whether a locale line carries ``value`` as one record (``lib/commcare/localeFile.ts::isLocaleFileValue``): no
    carriage return, which ends the line in Core's reader while ``dumps`` leaves it, and a spelling ``dumps`` writes
    (a Python-blank text as a non-breaking space, a line break as ``\\n``) that is not only characters Java's
    ``String.trim()`` drops."""
    if "\r" in value:
        return False
    return not value.strip() or any(ord(character) > 0x20 for character in value.replace("\n", "\\n"))


def _reader():
    """HQ's app strings reader (``commcare_translations``), from HQ's checkout where HQ has not put it on the path."""
    try:
        import commcare_translations
    except ImportError:
        sys.path.append(str(TRANSLATIONS))
        import commcare_translations
    return commcare_translations


def parse_app_strings(content):
    """The strings map HQ's reader makes of one app strings file."""
    commcare_translations = _reader()

    if isinstance(content, bytes):
        content = content.decode("utf-8")
    return commcare_translations.loads(content)


def read_back(key, text):
    """What HQ's reader reads of one string HQ's build wrote: ``text`` under ``key`` written by
    ``commcare_translations.dumps`` (a blank text as a non-breaking space, a line break as ``\\n``, an unescaped
    ``#`` escaped) and read by ``loads``, which strips each line."""
    commcare_translations = _reader()
    return commcare_translations.loads(commcare_translations.dumps({key: text})).get(key.strip())


def compare_strings_maps(before, after, *, check, document, artifact):
    """Every key whose value differs between two read app strings maps."""
    found = []
    for key in sorted(set(before) | set(after)):
        path, at = key_path(key), f"/{pointer_token(key)}"
        if key not in after:
            found.append(Difference(check, document, artifact, path, at, "removed", before[key], None))
        elif key not in before:
            found.append(Difference(check, document, artifact, path, at, "added", None, after[key]))
        elif before[key] != after[key]:
            found.append(Difference(check, document, artifact, path, at, "changed", before[key], after[key]))
    return found


def compare_app_strings(before, after, *, check, document, artifact, normalize=()):
    """Every difference between two app strings files given as text or bytes."""
    strings_a = parse_app_strings(before)
    strings_b = parse_app_strings(after)
    for rule in normalize:
        strings_a = rule(strings_a)
        strings_b = rule(strings_b)
    return compare_strings_maps(strings_a, strings_b, check=check, document=document, artifact=artifact)


def main(argv):
    """Write ``app_strings_families.json`` from HQ's registry, with HQ booted."""
    from proof.hq.boot import boot

    boot()
    path = Path(argv[0]) if argv else FAMILIES_JSON
    path.write_text(families_json(hq_key_families()), encoding="utf-8")
    print(f"Wrote {len(hq_key_families())} key families to {path}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
