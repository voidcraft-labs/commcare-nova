"""The build seams keep what HQ's build works out again, and HQ computes every byte it did: ``proof.hq.buildcache``.

Contract: with the build seams on, every build HQ makes gives the same
``validate_app()`` errors, the same files, the same forms sent to
Formplayer, the same flag reads in the same order, the same soft assertions
and the same draws of entropy after it as with them off, however many times
the same app is built in one state; and each seam answers exactly what it
stands in for. The plausible failures: an answer kept for an input that
differs in something its key leaves out (a flag a flip turns, a namespace, a
prefix reading, a blob gone after a restore); a kept answer handed out
shared, so a caller's change reaches the next; a flag read or an entropy draw
the left-out computation made, so the record or every later random draw
moves (HQ's timer draws a ``uuid4`` for each timed call); and a stand-in for
library code that has since changed.

Every comparison opens the seams with ``speed.on()`` and closes them with
``speed.off()``, so it holds whichever the process booted with
(``PROOF_HQ_SPEED``), each build inside one operation key so its entropy and
clock are the same either way.
"""

from __future__ import annotations

import hashlib
import pickle
import uuid

import pytest
from lxml import etree

from proof.editors.conftest import ADVANCED_APP, SUITE_APP, TWO_LANGUAGE_APP, publish_hq_app
from proof.hq import buildcache, determinism, operations, seams, speed
from proof.hq.boot import clear_caches, soft_assertions
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.determinism import operation

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


def _build(state, record, app_id, key, previous=None):
    """One build as the observation makes it (caches emptied, the app read afresh) and everything it left."""
    from proof.observe.build import build_state

    flags, validations = len(record.flags), len(record.form_validations)
    with operation(key, 3), soft_assertions() as notes:
        clear_caches()
        app = operations.held_app(state, app_id)
        with seams.build_seams(previous=previous):
            outcome, hq_build = build_state(app, record, "x")
        after = uuid.uuid4().hex  # the next draw: the same only where the build drew as many
    return (
        {
            "errors": outcome.errors,
            "raised": outcome.raised,
            "files": outcome.files,
            "profiles": outcome.profile_files,
            "validated": [v.xml for v in record.form_validations[validations:]],
            "flags": [(r.symbol, r.item, r.namespace, r.via, r.verdict) for r in record.flags[flags:]],
            "notes": [(n.message, n.where) for n in notes],
            "next draw": after,
        },
        hq_build,
    )


@pytest.mark.parametrize("name", [SUITE_APP, ADVANCED_APP, TWO_LANGUAGE_APP])
def test_every_build_gives_the_same_bytes_and_draws_with_the_build_seams_as_without(hq, core_runner, monkeypatch, name):
    monkeypatch.setattr(determinism, "ENABLED", True)
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, record):
        app_id = publish_hq_app(state, name)
        key = hashlib.sha256(f"proof build seams|{name}".encode()).digest()
        with speed.off():
            plain, hq_build = _build(state, record, app_id, key)
            previous = hq_build.saved_build()
            again = _build(state, record, app_id, key + b"again", previous)[0]
        with speed.on():
            hits = buildcache.XPATHS.hits
            seamed = [_build(state, record, app_id, key)[0] for _ in range(3)]
            seamed_again = [_build(state, record, app_id, key + b"again", previous)[0] for _ in range(2)]
            assert buildcache.XPATHS.hits > hits
    assert plain["files"], "HQ built nothing, so the comparison proves nothing"
    assert plain["flags"] and plain["validated"]
    assert all(build == plain for build in seamed), name
    assert all(build == again for build in seamed_again), name


def test_a_kept_answer_is_given_again_only_while_each_flag_it_read_reads_the_same(hq, core_runner):
    """Questions computed with SAVE_ONLY_EDITED_FORM_FIELDS off are not the answer a flip turning it on gets:
    the flip computes them again, and every use makes the flag read the computation would."""
    with speed.on(), hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, record):
        app = operations.held_app(state, publish_hq_app(state, SUITE_APP))
        form = app.get_module(0).get_form(0)
        memo = form.get_questions.__wrapped__.get_cached_value.__self__.fn.memo

        def questions():
            clear_caches()
            start = len(record.flags)
            found = form.get_questions(app.langs, include_triggers=True)
            reads = [(r.symbol, r.verdict) for r in record.flags[start:]]
            return found, reads

        first, first_reads = questions()
        hits = memo.hits
        second, second_reads = questions()
        assert memo.hits == hits + 1
        assert second == first and second is not first
        assert second_reads == first_reads == [("SAVE_ONLY_EDITED_FORM_FIELDS", False)]
        # Unshared: a caller's change reaches neither the kept answer nor the next caller.
        second[0]["label"] = "changed"
        assert questions()[0] == first

        flipped = Configuration(privileges={"CLOUDCARE"}, flags={"SAVE_ONLY_EDITED_FORM_FIELDS"})
        flip_record = seams.SeamRecord()
        with seams.flags(flipped, flip_record):
            hits = memo.hits
            clear_caches()
            on = form.get_questions(app.langs, include_triggers=True)
            assert memo.hits == hits  # computed, not kept
            assert [(r.symbol, r.verdict) for r in flip_record.flags] == [("SAVE_ONLY_EDITED_FORM_FIELDS", True)]
        assert on == first
        hits = memo.hits
        questions()
        assert memo.hits == hits + 1


# A form whose questions differ by every argument the questions memo keys: a question in a group, a trigger, and
# labels in two languages.
QUESTIONS_SOURCE = """<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <h:head>
    <h:title>Questions</h:title>
    <model>
      <instance>
        <data xmlns="http://openrosa.org/formdesigner/proof-questions" uiVersion="1" version="1" name="Questions">
          <visit><name/></visit>
          <note/>
        </data>
      </instance>
      <bind nodeset="/data/visit/name" type="xsd:string"/>
      <bind nodeset="/data/note" readonly="true()"/>
      <itext>
        <translation lang="en" default="">
          <text id="visit-label"><value>Visit</value></text>
          <text id="name-label"><value>Name</value></text>
          <text id="note-label"><value>Read this</value></text>
        </translation>
        <translation lang="fr">
          <text id="visit-label"><value>Visite</value></text>
          <text id="name-label"><value>Nom</value></text>
          <text id="note-label"><value>Lisez ceci</value></text>
        </translation>
      </itext>
    </model>
  </h:head>
  <h:body>
    <group ref="/data/visit">
      <label ref="jr:itext('visit-label')"/>
      <input ref="/data/visit/name"><label ref="jr:itext('name-label')"/></input>
    </group>
    <trigger ref="/data/note"><label ref="jr:itext('note-label')"/></trigger>
  </h:body>
</h:html>
"""


class _QuestionsForm:
    """A form as the questions memo and HQ's computation read one: its source and its app's domain."""

    source = QUESTIONS_SOURCE

    def get_app(self):
        class App:
            domain = "proof"

        return App()


def test_each_language_list_and_argument_set_is_answered_for_itself(hq, core_runner):
    """One source asked for its questions under two language lists and two argument sets, in both orders: the
    first ask of each is computed, each later one is the kept answer for exactly its own arguments, and every
    answer is what HQ's uncached computation gives for them (HQ asks one form with different arguments:
    ``models/forms.py`` with ``include_triggers`` and ``include_groups``, with ``langs=[]``, with
    ``include_triggers`` alone; ``views/forms.py`` with the request's languages)."""
    asks = [
        (langs, arguments)
        for langs in (["en", "fr"], ["fr"])
        for arguments in ({"include_triggers": True, "include_groups": True}, {})
    ]
    computed = []

    def compute(
        self,
        langs,
        include_triggers=False,
        include_groups=False,
        include_translations=False,
        include_fixtures=False,
        include_locked_status=False,
    ):
        computed.append((tuple(langs), include_triggers, include_groups))
        return buildcache._uncached_questions(
            self,
            langs,
            include_triggers=include_triggers,
            include_groups=include_groups,
            include_translations=include_translations,
            include_fixtures=include_fixtures,
            include_locked_status=include_locked_status,
        )

    with hq_check(CONFIGURATION, validate=core_runner.validate_form):
        form = _QuestionsForm()
        expected = [buildcache._uncached_questions(form, list(langs), **arguments) for langs, arguments in asks]
        # Each ask's answer differs from every other's, so an answer given for another ask is caught.
        assert all(expected[i] != expected[j] for i in range(len(asks)) for j in range(i))
        memo = buildcache.QuestionsMemo(compute)
        with operation(b"\x02" * 32, 1):
            for index, (langs, arguments) in enumerate(asks):
                hits = memo.hits
                assert memo(form, list(langs), **arguments) == expected[index]
                assert memo.hits == hits and len(computed) == index + 1  # computed, never kept for another ask
            for index in reversed(range(len(asks))):
                langs, arguments = asks[index]
                hits = memo.hits
                assert memo(form, list(langs), **arguments) == expected[index]
                assert memo.hits == hits + 1
    assert len(computed) == len(asks)


def test_compiled_xpaths_answer_as_the_elements_evaluation_does(hq):
    root = etree.fromstring(b'<s xmlns:p="urn:p"><d id="a" p:k="1"><t>x</t><t>y</t></d><d id="b"/><!-- c --></s>')
    context = {"namespaces": {"p": "urn:p", "re": "http://exslt.org/regular-expressions"}}
    expressions = [
        "d",
        "d[@id='b']",
        "d/@id",
        "d/@p:k",
        "d/t/text()",
        "count(d)",
        "string(d/t)",
        "boolean(d[@id='c'])",
        "comment()",
        "re:test(d/@id, '^a$')",
    ]
    for path in expressions:
        compiled = buildcache.XPATHS.evaluate(root, path, {"namespaces": {**context["namespaces"]}})
        assert buildcache._same_result(compiled, root.xpath(path, **context)), path
        again = buildcache.XPATHS.evaluate(root, path, context)
        assert buildcache._same_result(again, root.xpath(path, **context)), path
    # An expression lxml refuses raises what the element's own evaluation raises.
    for path, ctx in (("d[", context), ("q:d", context)):
        with pytest.raises(etree.XPathError) as own:
            root.xpath(path, **ctx)
        with pytest.raises(type(own.value)):
            buildcache.XPATHS.evaluate(root, path, ctx)
    # The same expression under other namespaces is another expression.
    other = {"namespaces": {"p": "urn:other"}}
    assert buildcache.XPATHS.evaluate(root, "d/@p:k", other) == root.xpath("d/@p:k", **other) == []


def test_selectors_kept_past_lxmls_hundred_find_what_lxml_compiles(hq):
    from lxml import _elementpath

    selectors = buildcache.Selectors(_elementpath._build_path_iterator)
    binds = "".join(f'<bind nodeset="/data/q{i}"/>' for i in range(150))
    root = etree.fromstring(f'<m xmlns="urn:f" xmlns:j="urn:j"><x j:a="1"/>{binds}</m>'.encode())
    namespaces = {"f": "urn:f", "j": "urn:j"}
    paths = [f"f:bind[@nodeset='/data/q{i}']" for i in range(150)] + ["f:x[@j:a='1']", "{urn:f}bind"]
    for _ in range(2):
        for path in paths:
            result = iter((root,))
            for select in selectors(path, namespaces):
                result = select(result)
            assert list(result) == root.findall(path, namespaces), path
    assert selectors.hits >= len(paths)
    # Each selector is the one lxml's builder gave for exactly its arguments: a path read without prefixes (an HTML
    # document's) is compiled and kept apart from the same path read with them.
    built = {}

    def builder(path, namespaces, with_prefixes=True):
        built[path, with_prefixes] = _elementpath._build_path_iterator(path, namespaces, with_prefixes)
        return built[path, with_prefixes]

    recorded = buildcache.Selectors(builder)
    for _ in range(2):
        for with_prefixes in (True, False):
            assert recorded("p:x", {"p": "urn:p"}, with_prefixes) is built["p:x", with_prefixes]
    assert built["p:x", True] is not built["p:x", False] and recorded.hits == 2
    # A path lxml refuses raises as lxml raises it, and nothing is kept for it.
    with pytest.raises(SyntaxError):
        selectors("/absolute", namespaces)
    with pytest.raises(SyntaxError):
        selectors("/absolute", namespaces)


def test_a_kept_version_parse_gives_each_object_its_own_components(hq):
    from looseversion import LooseVersion

    with speed.on():
        parses = LooseVersion.parse.parses
        hits = parses.hits
        a, b = LooseVersion("2.53.1b"), LooseVersion("2.53.1b")
        assert parses.hits > hits  # the second parse was the kept one
        assert a.version == b.version == [2, 53, 1, "b"] and a.version is not b.version
        assert LooseVersion("2.53") < a and str(a) == "2.53.1b"
        b.version.append(9)
        assert LooseVersion("2.53.1b").version == [2, 53, 1, "b"]


def test_a_saved_builds_attachments_are_its_own_bytes_while_the_blob_store_holds_them(hq, core_runner):
    from corehq.blobs.mixin import BlobMixin
    from couchdbkit.exceptions import ResourceNotFound
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with speed.on(), hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, record):
        app_id = publish_hq_app(state, SUITE_APP)
        with seams.build_seams():
            hq_build = operations.build(operations.held_app(state, app_id), record)
        mark = state.mark()
        with state.operation("save-build", b""):
            saved = hq_build.saved_build()
        names = sorted(getattr(saved, buildcache.KEPT_ATTACHMENTS))
        assert any(name.startswith("files/") for name in names)
        hq_fetch = BlobMixin.fetch_attachment.__wrapped__
        for name in names:
            with CaptureQueriesContext(connection) as queries:
                kept = saved.fetch_attachment(name)
            assert not queries.captured_queries  # answered without the BlobMeta query
            assert kept == hq_fetch(saved, name)
        # Restored to before the saved build existed, its blobs are gone, and HQ's own read answers.
        state.restore(mark)
        with pytest.raises(ResourceNotFound):
            saved.fetch_attachment(names[0])


def test_an_attachment_read_again_is_given_while_its_blobs_row_and_file_are_as_they_were(hq, core_runner, monkeypatch):
    """An attachment HQ read once is given again for any document naming the same blob, with one statement and
    no query HQ's ORM builds, while the blob's metadata row (its parent, key and compression) and its file are as
    they were; where any of them changed, HQ reads it, and answers or raises as it does."""
    import gzip

    from corehq.blobs import get_blob_db
    from corehq.blobs.mixin import BlobMixin
    from corehq.blobs.models import BlobMeta
    from corehq.sql_db.routers import HINT_PARTITION_VALUE
    from couchdbkit.exceptions import ResourceNotFound
    from django.db import connection, connections, router
    from django.test.utils import CaptureQueriesContext

    table = BlobMeta._meta.db_table
    with speed.on(), hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        app_id = publish_hq_app(state, SUITE_APP)
        hq_fetch = BlobMixin.fetch_attachment.__wrapped__
        app = operations.held_app(state, app_id)
        name = next(name for name in sorted(app.external_blobs) if name.endswith(".xml"))
        source = hq_fetch(app, name)
        assert app.fetch_attachment(name) == source  # HQ's read, kept
        hits = buildcache.ATTACHMENTS.hits
        again = operations.held_app(state, app_id)  # another object naming the same blob
        # The database HQ's MetaDB.get reads the row from.
        metadata = connections[router.db_for_read(BlobMeta, **{HINT_PARTITION_VALUE: app_id})]
        with CaptureQueriesContext(metadata) as queries:
            assert again.fetch_attachment(name) == source
        assert buildcache.ATTACHMENTS.hits == hits + 1
        assert [query["sql"].split(" FROM ")[0] for query in queries.captured_queries] == [
            'SELECT "compressed_length" IS NOT NULL'
        ]

        key = again.external_blobs[name].key
        path = get_blob_db().get_path(key)
        # The file changed under its row: HQ reads it again.
        with open(path, "wb") as stream:
            stream.write(b"<changed/>")
        assert again.fetch_attachment(name) == b"<changed/>" == hq_fetch(again, name)
        with open(path, "wb") as stream:
            stream.write(source)
        assert again.fetch_attachment(name) == source
        # The row says the blob is compressed: HQ reads the file through gzip, and so it is read.
        with connection.cursor() as cursor:
            cursor.execute(f'UPDATE "{table}" SET compressed_length = content_length WHERE key = %s', [key])
        with pytest.raises(gzip.BadGzipFile):
            again.fetch_attachment(name)
        with connection.cursor() as cursor:
            cursor.execute(f'UPDATE "{table}" SET compressed_length = NULL WHERE key = %s', [key])
        assert again.fetch_attachment(name) == source
        # A document of another id naming the same key has no row of its own: HQ refuses it.
        other = operations.held_app(state, app_id)
        other._id = "proof-other-parent"
        with pytest.raises(ResourceNotFound):
            other.fetch_attachment(name)
        # Verified, a kept answer HQ's read does not give is refused.
        monkeypatch.setattr(buildcache, "VERIFY_MEMOS", True)
        compressed, stored, _ = buildcache.ATTACHMENTS.kept[app_id, key]
        buildcache.ATTACHMENTS.kept[app_id, key] = (compressed, stored, b"<kept/>")
        with pytest.raises(seams.MemoMismatch, match=name):
            again.fetch_attachment(name)
        monkeypatch.setattr(buildcache, "VERIFY_MEMOS", False)
        # The row gone (deleted in SQL alone, its file still there): HQ refuses, and the kept answer is not given.
        with connection.cursor() as cursor:
            cursor.execute(f'DELETE FROM "{table}" WHERE key = %s', [key])
        with pytest.raises(ResourceNotFound):
            again.fetch_attachment(name)


def test_a_stand_in_for_code_that_changed_is_refused(hq, monkeypatch):
    def answer():
        return 1

    with pytest.raises(buildcache.SeamOutOfDate, match="no longer that"):
        buildcache.check_sources({"looseversion.LooseVersion.parse": answer})
    monkeypatch.setitem(buildcache.SOURCES, "looseversion.LooseVersion.parse", buildcache._source_digest(answer))
    buildcache.check_sources({"looseversion.LooseVersion.parse": answer})


def test_the_language_file_memo_parses_as_json_does_and_shares_nothing(hq, monkeypatch):
    import io
    import json

    text = '[{"two": "en", "names": ["English"]}]'
    memo = buildcache.JsonMemo(json)
    stream = io.StringIO(text)
    stream.name = "langs.json"
    first = memo.load(stream)
    stream.seek(0)
    second = memo.load(stream)
    assert memo.hits == 1 and first == second == json.loads(text) and first is not second
    # A copy handed out (the kept parse's, not the first parse itself) changed by its caller reaches no later load.
    second[0]["names"].append("changed")
    first[0]["two"] = "changed"
    stream.seek(0)
    assert memo.load(stream) == json.loads(text) and memo.hits == 2
    other = io.StringIO('[{"two": "fr", "names": ["French"]}]')
    other.name = "langs.json"
    assert memo.load(other)[0]["two"] == "fr"
    # Verified, a kept parse that is not the file's parse is refused.
    monkeypatch.setattr(buildcache, "VERIFY_MEMOS", True)
    stream.seek(0)
    assert memo.load(stream) == json.loads(text)
    key = next(key for key in memo.parsed if key[1] == text)
    memo.parsed[key] = pickle.dumps([{"two": "en", "names": ["Anglais"]}])
    stream.seek(0)
    with pytest.raises(seams.MemoMismatch, match="langs.json"):
        memo.load(stream)


class _Form:
    """A form as the questions memo reads one: its source and its app's domain."""

    source = "<h:html/>"

    def get_app(self):
        class App:
            domain = "proof"

        return App()


def test_a_computation_that_draws_entropy_or_notes_an_assertion_is_never_kept(hq, core_runner):
    """Leaving out a computation that drew would move every later draw of its scope, and one HQ noted a soft
    assertion in would lose the note: neither is kept, and a quiet one is."""
    from corehq.util.soft_assert import soft_assert

    def drawing(self, langs, include_triggers=False):
        return [uuid.uuid4().hex]

    def noting(self, langs, include_triggers=False):
        soft_assert(notify_admins=False)(False, "proof note")
        return ["noted"]

    def quiet(self, langs, include_triggers=False):
        return ["quiet"]

    with hq_check(CONFIGURATION, validate=core_runner.validate_form):
        for compute, kept in ((drawing, False), (noting, False), (quiet, True)):
            memo = buildcache.QuestionsMemo(compute)
            with operation(b"\x01" * 32, 1):
                memo(_Form(), [])
                memo(_Form(), [])
            assert (memo.hits == 1) is kept, compute.__name__
