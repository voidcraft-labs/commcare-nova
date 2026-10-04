"""Everything HQ's build writes, parsed and compared file by file.

``create_all_files()`` returns a map from each built file's path to its
bytes (``models/applications.py::Application.create_all_files``): the
profiles (``profile.xml``, ``profile.ccpr``, ``media_profile.xml``,
``media_profile.ccpr``, and a flavor's ``profile-<flavor>.*``), the suites
(``suite.xml``, ``media_suite.xml``), a practice user's restore, one app
strings file per language and ``default`` (``<lang>/app_strings.txt``), and
one XForm per form (``modules-<m>/forms-<f>.xml``). A build profile's
``create_all_files(build_profile_id)`` writes the same files, each path
already under ``<profile id>/`` (the ``prefix`` it gives every path).

Every file has a comparator or the comparison refuses the build
(``NoComparator``): an XML file (``.xml``, ``.ccpr``) is compared as a parsed
tree (``xml_tree``, which names a form's data and keys its binds and
setvalues by the node they name), an app strings file as its map
(``app_strings``), a language's as Core reads it (``as_read``: the
``default`` file's strings overlaid by the language's own); a file that does
not parse is refused at ``/not-well-formed``, its cause. Each
file is named as an artifact (``artifact_for``): ``form:<m>.<f>`` for a form,
``app_strings:<lang>`` for an app strings file, the file name otherwise, and
``<profile id>/`` before that for a build profile's file (its path read
without the profile's prefix), so a rule or a register entry names a
profile's forms as ``<profile id>/form:*`` and every build's as ``*form:*``.
Each parsed file is keyed by the path HQ gave it.

A build profile's build is the app's build restricted to the profile's
languages (``Application.create_all_files(build_profile_id)``: the same
files, each form's translations and the app strings kept to its languages),
so a change to the app shows in its files as in the main build's. A
difference in a profile's file that the main build's same file shows too, at
the same place, from the same value to the same value, is that symptom
again, and is reported once, on the main build (``once_per_symptom``); one a
profile's file shows otherwise is its own.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from proof.checks.compare.app_strings import compare_strings_maps, parse_app_strings
from proof.checks.compare.spelling import normalizers
from proof.checks.compare.xml_tree import NOT_WELL_FORMED, XmlNotWellFormed, compare_xml_trees, parse_xml
from proof.checks.differences import Difference


class NoComparator(AssertionError):
    """HQ's build wrote a file the comparison has no parser for, so it cannot compare it."""


@dataclass(frozen=True)
class BuiltFile:
    path: str
    artifact: str
    kind: str  # "xml" or "app_strings"
    parsed: object  # the lxml root, the strings map, or None when it did not parse
    error: str | None = None


def _base_artifact(path):
    parts = path.split("/")
    if len(parts) == 2 and parts[1] == "app_strings.txt":
        return f"app_strings:{parts[0]}"
    if (
        len(parts) == 2
        and parts[0].startswith("modules-")
        and parts[1].startswith("forms-")
        and parts[1].endswith(".xml")
    ):
        module = parts[0].removeprefix("modules-")
        form = parts[1].removeprefix("forms-").removesuffix(".xml")
        if module.isdigit() and form.isdigit():
            return f"form:{module}.{form}"
    return path


def artifact_for(path, profile_id=None):
    """The artifact name of one built file; a build profile's path is read without the profile's prefix."""
    if profile_id is None:
        return _base_artifact(path)
    prefix = f"{profile_id}/"
    if not path.startswith(prefix):
        raise ValueError(
            f"HQ's build of the profile {profile_id} wrote {path}, outside {prefix}, where"
            " Application.create_all_files(build_profile_id) puts every file it writes for a build profile."
        )
    return f"{prefix}{_base_artifact(path.removeprefix(prefix))}"


def comparator_kind(path):
    """Which comparator reads the file, or None when none does."""
    if path.endswith(".xml") or path.endswith(".ccpr"):
        return "xml"
    if path.endswith("/app_strings.txt"):
        return "app_strings"
    return None


def parse_build_files(files, *, rules, profile_id=None):
    """Each built file parsed by its comparator's parser, keyed by HQ's path; NoComparator names any other file.

    ``profile_id`` names the build profile ``files`` were built for (HQ's
    ``create_all_files(build_profile_id)``), whose paths HQ already wrote
    under ``<profile id>/``. Each file is read after the spelling rules in
    ``rules`` that apply to its artifact (``compare.spelling``: the judges
    give the registered set, and ``()`` reads every file raw).
    """
    parsed = {}
    unreadable = sorted(path for path in files if comparator_kind(path) is None)
    if unreadable:
        raise NoComparator(
            f"HQ's build wrote {unreadable}, which proof/checks/compare/build_files.py has no comparator for,"
            " so the build cannot be compared whole. Teach it a parser for these files."
        )
    for path, content in sorted(files.items()):
        artifact = artifact_for(path, profile_id)
        kind = comparator_kind(path)
        if kind == "xml":
            try:
                root = parse_xml(content)
            except XmlNotWellFormed as error:
                parsed[path] = BuiltFile(path, artifact, kind, None, str(error))
                continue
            for normalize in normalizers(artifact, rules):
                root = normalize(root)
            parsed[path] = BuiltFile(path, artifact, kind, root)
        else:
            strings = parse_app_strings(content)
            for normalize in normalizers(artifact, rules):
                strings = normalize(strings)
            parsed[path] = BuiltFile(path, artifact, kind, strings)
    return parsed


DEFAULT_STRINGS = "default"
STRINGS_FILE = "app_strings.txt"


def as_read(parsed):
    """A parsed build (``parse_build_files`` output) with each language's app strings as Core reads them: the
    ``default`` file's strings, overlaid by the language's own.

    Core loads the default locale's text first and lets the current locale
    overwrite it (``javarosa/core/services/locale/Localizer.java::getLocaleData``,
    the localizer built with ``fallbackDefaultLocale``, ``LocalizerManager``),
    and the default locale is ``default`` (Android sets it,
    ``CommCareApplication.java``; Formplayer registers HQ's ``default`` file
    first, ``Localization.registerLanguageReference``). So a key a language's
    file leaves out reads the default file's text, and two builds whose
    language files differ only there show a language the same text.
    """
    shown = dict(parsed)
    for path, built in parsed.items():
        if built.kind != "app_strings" or built.parsed is None:
            continue
        head, _, language = path.removesuffix(f"/{STRINGS_FILE}").rpartition("/")
        if language == DEFAULT_STRINGS:
            continue
        default = parsed.get(
            f"{head}/{DEFAULT_STRINGS}/{STRINGS_FILE}" if head else f"{DEFAULT_STRINGS}/{STRINGS_FILE}"
        )
        if default is not None and default.parsed is not None:
            shown[path] = replace(built, parsed={**default.parsed, **built.parsed})
    return shown


def _base(artifact):
    """A built file's artifact as the main build names it: a build profile's without its ``<profile id>/``."""
    return artifact.split("/", 1)[1] if "/" in artifact else artifact


def once_per_symptom(found):
    """The differences without each of a build profile's file that the main build's same file shows alike."""
    main = {
        (
            difference.artifact,
            difference.path,
            difference.at,
            difference.kind,
            repr(difference.before),
            repr(difference.after),
        )
        for difference in found
        if "/" not in difference.artifact
    }
    return [
        difference
        for difference in found
        if "/" not in difference.artifact
        or (
            _base(difference.artifact),
            difference.path,
            difference.at,
            difference.kind,
            repr(difference.before),
            repr(difference.after),
        )
        not in main
    ]


def compare_parsed_builds(before, after, *, check, document):
    """Every difference between two parsed builds (``parse_build_files`` output), file by file, each language's
    app strings as Core reads them (``as_read``), a build profile's alike to the main build's reported once
    (``once_per_symptom``)."""
    before, after = as_read(before), as_read(after)
    found = []
    for path in sorted(set(before) | set(after)):
        a, b = before.get(path), after.get(path)
        artifact = (a or b).artifact
        if a is None:
            found.append(Difference(check, document, artifact, "/", "/", "added", None, path))
            continue
        if b is None:
            found.append(Difference(check, document, artifact, "/", "/", "removed", path, None))
            continue
        if a.error or b.error:
            # A file that does not parse cannot be compared, on either side: its cause is the path.
            found.append(
                Difference(check, document, artifact, NOT_WELL_FORMED, NOT_WELL_FORMED, "refused", a.error, b.error)
            )
            continue
        if a.kind == "xml":
            found.extend(compare_xml_trees(a.parsed, b.parsed, check=check, document=document, artifact=artifact))
        else:
            found.extend(compare_strings_maps(a.parsed, b.parsed, check=check, document=document, artifact=artifact))
    return once_per_symptom(found)
