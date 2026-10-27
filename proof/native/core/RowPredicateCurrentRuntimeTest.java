package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Hashtable;
import org.commcare.cases.model.Case;
import org.commcare.session.SessionFrame;
import org.commcare.session.SessionInstanceBuilder;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryModel;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xform.util.XFormUtils;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * A repeat's form read inside a secondary instance's row predicate, as Nova
 * prints it, over the forms the expression producer writes as
 * /expression/row-predicates/ with their rows in
 * /expression/row-predicates.json (lib/commcare/__tests__/rowPredicateFixture.ts).
 *
 * Core gives a predicate's right side the bind's context or the row's,
 * depending on its predicates: a leading predicate on an indexed casedb path
 * is answered in the outer context through the storage index
 * (StorageBackedTreeRoot.tryBatchChildFetch), an attribute equality over an
 * in-memory fixture likewise (TreeElement.tryBatchChildFetch ->
 * TreeUtilities.tryBatchChildFetch), and any other predicate row by row
 * (EvaluationContext.expandReferenceAccumulator), where an absolute main
 * instance path contextualized against a row is cloned unbound
 * (TreeReference.contextualize) and names every entry of the repeat.
 * current() is the bind's node under each (EvaluationContext.rescope).
 *
 * With two entries answered differently, Nova's current()/../kind print
 * gives each entry its own count under all three predicates. The bare
 * /data/visits/kind print, the retained control made from the same bytes,
 * answers per entry where the predicate is answered in the bind's context and
 * answers every entry with the first entry's read where it is evaluated row by row.
 *
 * Plausible failure: a print that names every entry of the repeat in one of
 * the evaluations, so a form stops or counts another entry's rows.
 */
public class RowPredicateCurrentRuntimeTest {
    private static JSONObject rows() throws Exception {
        try (InputStream input = RowPredicateCurrentRuntimeTest.class.getResourceAsStream("/expression/row-predicates.json")) {
            assertNotNull("The expression producer did not supply row-predicates.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown row predicate rows version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    private static String source(JSONObject rows) throws Exception {
        try (InputStream input = RowPredicateCurrentRuntimeTest.class.getResourceAsStream(rows.getString("form"))) {
            assertNotNull("The expression producer did not supply " + rows.getString("form"), input);
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static TreeElement node(String name, String value) {
        TreeElement element = new TreeElement(name, 0);
        if (value != null) element.setValue(new StringData(value));
        return element;
    }

    /** The device: the visit cases in storage (so the casedb answers its
     * indexed paths through the index), the places as an in-memory fixture,
     * and a session that chose nothing. */
    private static final class Device extends TestInstanceInitializer {
        private final JSONArray places;

        Device(JSONObject rows) {
            this(MockDataUtils.getStaticStorage(), rows);
        }

        private Device(MockUserDataSandbox sandbox, JSONObject rows) {
            super(sandbox);
            this.places = rows.getJSONArray("places");
            JSONArray cases = rows.getJSONArray("cases");
            for (int index = 0; index < cases.length(); index++) {
                JSONObject row = cases.getJSONObject(index);
                Case visit = new Case(row.getString("id"), "visit");
                visit.setCaseId(row.getString("id"));
                visit.setUserId(row.getString("owner"));
                visit.setProperty("kind_text", row.getString("kindText"));
                sandbox.getCaseStorage().write(visit);
            }
        }

        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            TreeElement root;
            if ("locations".equals(instance.getInstanceId())) {
                root = node("locations", null);
                for (int index = 0; index < places.length(); index++) {
                    JSONObject place = places.getJSONObject(index);
                    TreeElement location = new TreeElement("location", index);
                    location.setAttribute(null, "id", place.getString("id"));
                    location.setAttribute(null, "type", place.getString("type"));
                    location.addChild(node("name", place.getString("name")));
                    root.addChild(location);
                }
            } else if ("commcaresession".equals(instance.getInstanceId())) {
                root = SessionInstanceBuilder.getSessionInstance(new SessionFrame(), "device", "1", 0L,
                        "worker", "worker-id", new Hashtable<>(), null, "en");
            } else {
                return super.generateRoot(instance);
            }
            InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
            return new ConcreteInstanceRoot(root);
        }
    }

    private static FormDef open(String xml, JSONObject rows) {
        FormDef form = XFormUtils.getFormFromInputStream(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
        assertNotNull("Core must parse the row predicate form", form);
        form.initialize(true, new Device(rows));
        return form;
    }

    private static TreeReference ref(FormDef form, String path) throws Exception {
        XPathNodeset target = (XPathNodeset)XPathParseTool.parseXPath(path).eval(form.getMainInstance(), form.getEvaluationContext());
        assertEquals("One node answers " + path, 1, target.size());
        return target.getRefAt(0);
    }

    private static String held(FormDef form, String path) throws Exception {
        return (String)ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(" + path + ")");
    }

    @Test public void eachEntryCountsItsOwnRowsUnderEveryEvaluation() throws Exception {
        JSONObject rows = rows();
        FormDef form = withEntries(source(rows), rows);
        JSONArray entries = rows.getJSONArray("entries");
        String repeat = rows.getString("repeat");
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            String at = repeat + "[" + (index + 1) + "]";
            for (String count : new String[]{"indexed", "scanned", "placed"}) {
                assertEquals("Entry " + (index + 1) + " (" + entry.getString("kind") + ") counts its own rows for "
                    + count, entry.getString(count), held(form, at + "/" + count));
            }
        }
    }

    @Test public void theBarePrintNamesEveryEntryWhereCoreScansRowByRow() throws Exception {
        JSONObject rows = rows();
        String bare = source(rows).replace(rows.getString("current"), rows.getString("bare"));
        assertNotEquals("The control holds no bare read", source(rows), bare);
        // Answered through the index in the bind's context: each entry's own.
        JSONArray entries = rows.getJSONArray("entries");
        String repeat = rows.getString("repeat");
        FormDef indexedOnly = withEntries(bare.replaceAll(
            "<bind type=\"xsd:string\" nodeset=\"/data/visits/(scanned|placed)\" calculate=\"[^\"]*\"/>", ""), rows);
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            assertEquals("The bare read through the index answers entry " + (index + 1) + " as its own",
                entry.getString("indexed"), held(indexedOnly, repeat + "[" + (index + 1) + "]/indexed"));
        }
        // Scanned row by row, the bare read is contextualized against a casedb row, so it is cloned unbound
        // (TreeReference.contextualize) and names every entry. contains() unpacks it (FunctionUtils.toString),
        // and the lazy nodeset reads an unbound path without expanding it (XPathLazyNodeset.unpack):
        // DataInstance.resolveReference answers it from its reference cache, which holds the entry it resolved
        // while the repeat held that entry alone. So no entry is refused, and every entry counts the first
        // entry's rows: a form that goes on with another entry's answer.
        String scannedOnly = bare.replaceAll(
            "<bind type=\"xsd:string\" nodeset=\"/data/visits/(indexed|placed)\" calculate=\"[^\"]*\"/>", "");
        FormDef scanned = withEntries(scannedOnly, rows);
        String first = entries.getJSONObject(0).getString("scanned");
        assertNotEquals("The rows give the entries different scanned counts", first,
            entries.getJSONObject(1).getString("scanned"));
        for (int index = 0; index < entries.length(); index++) {
            assertEquals("The bare read scanned row by row answers entry " + (index + 1) + " with the first entry's"
                + " count", first, held(scanned, repeat + "[" + (index + 1) + "]/scanned"));
        }
    }

    /** The form walked as a worker fills it: one entry per row of `entries`,
     * each answered with its kind, and no entry more. */
    private static FormDef withEntries(String xml, JSONObject rows) throws Exception {
        FormDef form = open(xml, rows);
        JSONArray entries = rows.getJSONArray("entries");
        String kind = rows.getString("kind");
        FormEntryController controller = new FormEntryController(new FormEntryModel(form));
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        int added = 0;
        int answered = 0;
        int steps = 0;
        int event;
        while ((event = controller.stepToNextEvent()) != FormEntryController.EVENT_END_OF_FORM) {
            if (++steps > 40) throw new AssertionError("The row predicate form did not finish");
            if (event == FormEntryController.EVENT_PROMPT_NEW_REPEAT) {
                if (added < entries.length()) {
                    controller.newRepeat();
                    added++;
                }
                continue;
            }
            if (event != FormEntryController.EVENT_QUESTION) continue;
            FormEntryPrompt prompt = controller.getModel().getQuestionPrompt();
            if (!kind.equals(prompt.getQuestion().getBind().getReference().getNameLast())) continue;
            assertEquals("Core took the answer of entry " + (answered + 1), FormEntryController.ANSWER_OK,
                controller.answerQuestion(new StringData(entries.getJSONObject(answered).getString("kind"))));
            answered++;
        }
        assertEquals("Every entry was answered", entries.length(), answered);
        return form;
    }
}
