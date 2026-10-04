"""Proof 2's version clause: which version numbers two builds of one app may differ in.

Two builds of one app always differ in the app's version, and HQ writes the
app's version wherever a built file names the build rather than its content:
the profile's own ``version`` and its suite and media suite resources
(``templates/app_manager/profile.xml``, ``{{ app.version }}``), each suite's
root ``version`` (``suite_xml/generator.py::SuiteGenerator`` and
``MediaSuiteGenerator``, ``Suite(version=self.app.version)``), and each app
strings resource (``suite_xml/sections/resources.py::LocaleResourceContributor``).
Those are read here as "the build's version": a value equal to its own
build's app version on each side is the same value.

A form's version and each media resource's version are HQ's decision about
content: ``Application.set_form_versions`` keeps the previous build's
version for a form whose rendered XForm hashes the same as that build's file
(written into the form's data node, ``FormBase.add_stuff_to_xform``, and its
suite resource, ``FormResourceContributor``), and ``set_media_versions``
keeps a media item's version while the previous build maps the same path to
the same ``multimedia_id``. A media resource's ``<media>`` element holds
both: its local location is the path, and its remote location is HQ's
download of that ``multimedia_id``
(``suite_xml/generator.py::MediaSuiteGenerator.media_resources``,
``reverse('hqmedia_download', args=[m.media_type, m.multimedia_id])``). The
clause holds that decision to the content: where a form's file (its data
node's ``version`` aside) or a ``<media>`` element (its resource's
``version`` aside) differs between the builds, its version may differ, and
is read as the same value on both sides; where the content is the same, its
version is compared as it is, so a version HQ changed with nothing changed
is a difference.

Everything is done on copies of the parsed files; nothing else is erased.
"""

from __future__ import annotations

import copy
from dataclasses import replace

from lxml import etree

from proof.checks.compare.xml_tree import compare_xml_trees

BUILD_VERSION = "{the build's app version}"
CONTENT_VERSION = "{a version, where the content differs}"


def _local(element):
    return etree.QName(element).localname if isinstance(element.tag, str) else None


def _children(element, name):
    return [child for child in element if isinstance(child.tag, str) and _local(child) == name]


def _data_node(form_root):
    """The XForm's data node: the first element of its model's first instance."""
    for head in _children(form_root, "head"):
        for model in _children(head, "model"):
            for instance in _children(model, "instance"):
                for child in instance:
                    if isinstance(child.tag, str):
                        return child
                return None
    return None


def _mark_build_version(root, app_version):
    """The build's own version, wherever HQ writes it, read as BUILD_VERSION."""
    marked = str(app_version)

    def mark(element):
        if element.get("version") == marked:
            element.set("version", BUILD_VERSION)

    if _local(root) == "profile":
        mark(root)
        for suite in _children(root, "suite"):
            for resource in _children(suite, "resource"):
                mark(resource)
    elif _local(root) == "suite":
        mark(root)
        for locale in _children(root, "locale"):
            for resource in _children(locale, "resource"):
                mark(resource)


def _form_resources(suite_root):
    """Each xform resource of a suite, keyed by the form file its local location names."""
    resources = {}
    for xform in _children(suite_root, "xform"):
        for resource in _children(xform, "resource"):
            for location in _children(resource, "location"):
                if location.get("authority") == "local" and location.text:
                    resources[location.text.strip().removeprefix("./")] = resource
    return resources


def _media_resources(suite_root):
    """Each media resource of a media suite, with its ``<media>`` element, keyed by resource id."""
    resources = {}
    for media in _children(suite_root, "media"):
        for resource in _children(media, "resource"):
            if resource.get("id") is not None:
                resources[resource.get("id")] = (media, resource)
    return resources


def _same_without(element_a, element_b, strip):
    """Whether two elements are the same once ``strip`` (run on copies) removed a version from each."""
    a, b = copy.deepcopy(element_a), copy.deepcopy(element_b)
    strip(a)
    strip(b)
    return not compare_xml_trees(a, b, check="proof2", document="-", artifact="-")


def apply_version_clause(before, after, *, app_version_before, app_version_after):
    """Both parsed builds (path -> BuiltFile) with the versions the clause accounts for made equal."""
    before = {path: _copied(built) for path, built in before.items()}
    after = {path: _copied(built) for path, built in after.items()}
    for built in before.values():
        if built.kind == "xml" and built.parsed is not None:
            _mark_build_version(built.parsed, app_version_before)
    for built in after.values():
        if built.kind == "xml" and built.parsed is not None:
            _mark_build_version(built.parsed, app_version_after)

    for prefix in _prefixes(before) & _prefixes(after):
        suite_a = _parsed(before, f"{prefix}suite.xml")
        suite_b = _parsed(after, f"{prefix}suite.xml")
        resources_a = _form_resources(suite_a) if suite_a is not None else {}
        resources_b = _form_resources(suite_b) if suite_b is not None else {}
        for form_path in sorted(set(resources_a) & set(resources_b)):
            form_a = _parsed(before, f"{prefix}{form_path}")
            form_b = _parsed(after, f"{prefix}{form_path}")
            if form_a is None or form_b is None:
                continue
            data_a, data_b = _data_node(form_a), _data_node(form_b)

            def strip(root):
                node = _data_node(root)
                if node is not None and "version" in node.attrib:
                    del node.attrib["version"]

            if not _same_without(form_a, form_b, strip):
                for data in (data_a, data_b):
                    if data is not None and "version" in data.attrib:
                        data.set("version", CONTENT_VERSION)
                resources_a[form_path].set("version", CONTENT_VERSION)
                resources_b[form_path].set("version", CONTENT_VERSION)

        media_suite_a = _parsed(before, f"{prefix}media_suite.xml")
        media_suite_b = _parsed(after, f"{prefix}media_suite.xml")
        if media_suite_a is not None and media_suite_b is not None:
            items_a = _media_resources(media_suite_a)
            items_b = _media_resources(media_suite_b)
            for resource_id in sorted(set(items_a) & set(items_b)):
                (media_a, resource_a), (media_b, resource_b) = items_a[resource_id], items_b[resource_id]

                def strip_version(media):
                    for resource in _children(media, "resource"):
                        resource.attrib.pop("version", None)

                if not _same_without(media_a, media_b, strip_version):
                    resource_a.set("version", CONTENT_VERSION)
                    resource_b.set("version", CONTENT_VERSION)
    return before, after


def _copied(built):
    if built.kind == "xml" and built.parsed is not None:
        return replace(built, parsed=copy.deepcopy(built.parsed))
    return built


def _prefixes(files):
    """The build profile prefixes present (``""`` for the default build)."""
    return {path[: -len("suite.xml")] for path in files if path == "suite.xml" or path.endswith("/suite.xml")}


def _parsed(files, path):
    built = files.get(path)
    return built.parsed if built is not None and built.kind == "xml" else None
