package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.core.process.XmlFormRecordProcessor;
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
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xml.util.InvalidStructureException;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/** Actual exported forms, native XPath, native case instance, native transaction
 * parser and storage records. In-memory storage does not prove rollback. */
@RunWith(Parameterized.class)
public class CaseOperationRuntimeTest {
    @Parameterized.Parameters(name = "HQ={0}")
    public static Collection<Object[]> paths() { return Arrays.asList(new Object[][]{{false}, {true}}); }
    private final boolean hq;
    public CaseOperationRuntimeTest(boolean hq) { this.hq = hq; }

    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private static class Run {
        final MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
        final FormParseInit parsed;
        final FormDef form;
        final String scenario;
        Run(String scenario, boolean hq) throws Exception {
            this.scenario = scenario;
            for (String[] seed : new String[][]{{"patient-1", "patient", "Original name"}, {"patient-2", "patient", "Other patient"}, {"visit-1", "visit", "Other visit"}}) {
                Case record = new Case(seed[2], seed[1]);
                record.setCaseId(seed[0]);
                record.setUserId("previous-owner");
                record.setProperty("nickname", "visit".equals(seed[1]) ? "Visit 1" : "Old nickname");
                if ("visit".equals(seed[1])) record.setIndex(new CaseIndex("parent", "patient", "patient-1"));
                record.setProperty("source_id", "Old source");
                sandbox.getCaseStorage().write(record);
            }
            if ("relation".equals(scenario) || "query".equals(scenario)) {
                Case unrelated = new Case("Other child", "visit");
                unrelated.setCaseId("visit-2");
                unrelated.setUserId("previous-owner");
                unrelated.setProperty("nickname", "Visit 2");
                unrelated.setIndex(new CaseIndex("parent", "patient", "patient-2"));
                sandbox.getCaseStorage().write(unrelated);
            }
            if ("nested".equals(scenario)) {
                Case household = new Case("Household name", "household");
                household.setCaseId("household-1");
                household.setUserId("previous-owner");
                household.setProperty("nickname", "Household value");
                sandbox.getCaseStorage().write(household);
                Case child = sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1");
                child.setIndex(new CaseIndex("parent", "household", "household-1"));
                sandbox.getCaseStorage().write(child);
            }
            parsed = new FormParseInit("/operation-" + scenario + (hq ? ".hq.xml" : ".xml"));
            form = parsed.getFormDef();
            form.initialize(true, new TestInstanceInitializer(sandbox) {
                @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                    if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                    TreeElement session = node("session", null);
                    TreeElement context = node("context", null);
                    for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) context.addChild(node(key, "fixture-" + key));
                    context.addChild(node("drift", "0"));
                    TreeElement data = node("data", null);
                    data.addChild(node("case_id", "nested".equals(scenario) ? "household-1" : "patient-1"));
                    if ("nested".equals(scenario)) data.addChild(node("case_id_patient", "patient-1"));
                    session.addChild(context);
                    session.addChild(data);
                    InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                    return new ConcreteInstanceRoot(session);
                }
            });
        }
        Object eval(String expression) throws Exception { return ExprEvalUtils.xpathEval(form.getEvaluationContext(), expression); }
        void answer(String path, String value) throws Exception {
            XPathNodeset nodes = (XPathNodeset)XPathParseTool.parseXPath(path).eval(form.getMainInstance(), form.getEvaluationContext());
            assertEquals("Answer one actual question " + path, 1, nodes.size());
            form.setValue(new StringData(value), nodes.getRefAt(0));
        }
        void enter(String scenario) throws Exception {
            FormEntryController controller = parsed.getFormEntryController();
            controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
            int steps = 0;
            int event;
            boolean created = false;
            while ((event = controller.stepToNextEvent()) != FormEntryController.EVENT_END_OF_FORM) {
                if (++steps > 70) throw new AssertionError("Form entry did not terminate");
                if (event == FormEntryController.EVENT_PROMPT_NEW_REPEAT && "repeat".equals(scenario) && !created) {
                    controller.newRepeat();
                    created = true;
                }
            }
        }
        void apply() throws Exception {
            form.postProcessInstance();
            byte[] submitted = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
            XmlFormRecordProcessor.process(sandbox, new ByteArrayInputStream(submitted));
        }
        Case record(String id) { return sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, id); }
    }
    private Run run(String scenario) throws Exception { return new Run(scenario, hq); }
    private static void assertVisit(Run run, String id, String name, boolean tagged) {
        Case visit = run.record(id);
        assertEquals("visit", visit.getTypeId());
        assertEquals(name, visit.getName());
        assertEquals("sequence".equals(run.scenario) ? "Old nickname" : "Original name", visit.getPropertyString("source_id"));
        assertEquals(tagged ? id : null, visit.getProperty("nickname"));
        assertEquals("-", visit.getUserId());
        assertTrue(visit.isClosed());
        assertEquals("Finished", visit.getPropertyString("final_note"));
        assertTrue(visit.getIndices().isEmpty());
    }
    @Test public void sequence() throws Exception {
        Run run = run("sequence");
        run.answer("/data/answer", "  Visit one  ");
        run.answer("/data/key", "write");
        run.answer("/data/ordinary_note", "Ordinary last");
        String id = (String)run.eval("/data/__nova_operations/create_visit/case/@case_id");
        assertFalse(id.isEmpty());
        run.apply();
        assertVisit(run, id, "Visit one", true);
        assertEquals("Ordinary last", run.record("patient-1").getPropertyString("nickname"));
        assertEquals(4, run.sandbox.getCaseStorage().getNumRecords());
    }
    @Test public void conditionalDependencyAndWrite() throws Exception {
        Run run = run("conditional");
        run.answer("/data/answer", "Conditional visit");
        run.answer("/data/enabled", "no");
        run.apply();
        assertEquals(3, run.sandbox.getCaseStorage().getNumRecords());
        run.answer("/data/enabled", "yes");
        String id = (String)run.eval("/data/__nova_operations/create_visit/case/@case_id");
        run.apply();
        assertVisit(run, id, "Conditional visit", false);
    }
    private void retype(String scenario) throws Exception {
        Run run = run(scenario);
        run.answer("/data/destination", "patient-1");
        run.answer("/data/answer", "Promoted name");
        run.answer("/data/enabled", "no");
        run.apply();
        assertEquals("patient", run.record("patient-1").getTypeId());
        assertEquals("Original name", run.record("patient-1").getName());
        assertFalse(run.record("patient-1").isClosed());
        run.answer("/data/enabled", "yes");
        run.apply();
        Case record = run.record("patient-1");
        assertEquals("visit", record.getTypeId());
        assertEquals("Promoted name", record.getName());
        assertEquals("Old source", record.getPropertyString("source_id"));
        assertTrue(record.isClosed());
    }
    @Test public void sessionRetype() throws Exception { retype("retype"); }
    @Test public void expressionRetypeUsesSnapshot() throws Exception { retype("expression-retype"); }
    private void repeated(String scenario) throws Exception {
        Run run = run(scenario);
        run.enter(scenario);
        String base = "query".equals(scenario) ? "/data/items/item" : "/data/items";
        int count = "query".equals(scenario) ? 2 : 1;
        assertEquals((double)count, run.eval("count(" + base + ")"));
        Set<String> ids = new HashSet<>();
        for (int index = 1; index <= count; index++) {
            String scope = base + "[" + index + "]";
            run.answer(scope + "/answer", "Visit " + index);
            run.answer(scope + "/key", "write");
            ids.add((String)run.eval(scope + "/__nova_operations/create_visit/case/@case_id"));
        }
        assertEquals(count, ids.size());
        run.apply();
        for (int index = 1; index <= count; index++) {
            String id = (String)run.eval(base + "[" + index + "]/__nova_operations/create_visit/case/@case_id");
            if (index == 1) assertVisit(run, id, "Visit " + index, true);
            else {
                Case skipped = run.record(id);
                assertEquals("Visit 2", skipped.getName());
                assertNull(skipped.getProperty("nickname"));
                assertEquals("fixture-userid", skipped.getUserId());
                assertTrue(skipped.isClosed());
                assertEquals("Finished", skipped.getPropertyString("final_note"));
                assertTrue(skipped.getIndices().isEmpty());
            }
        }
        assertEquals(("query".equals(scenario) ? 4 : 3) + count, run.sandbox.getCaseStorage().getNumRecords());
    }
    @Test public void repeatedGeneratedIds() throws Exception { repeated("repeat"); }
    @Test public void queryGeneratedIds() throws Exception { repeated("query"); }
    @Test public void exactAuthoredKeysAndBounds() throws Exception {
        String prefix = "nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:";
        for (String key : new String[]{" External/42 ", "é", "e\u0301", "😀".repeat(102) + "x"}) {
            Run run = run("key");
            run.answer("/data/answer", "Keyed visit");
            run.answer("/data/key", key);
            assertEquals(prefix + key, run.eval("/data/__nova_operations/create_visit/case/@case_id"));
            run.apply();
            assertEquals("Keyed visit", run.record(prefix + key).getName());
            assertEquals("fixture-userid", run.record(prefix + key).getUserId());
            assertEquals("patient-1", run.record(prefix + key).getIndices().get(0).getTarget());
        }
        for (String key : new String[]{"", "x".repeat(206), "😀".repeat(103)}) {
            Run run = run("key");
            run.answer("/data/answer", "Keyed visit");
            run.answer("/data/key", key);
            assertThrows(InvalidStructureException.class, run::apply);
        }
    }
    @Test public void repeatedAuthoredKeysDeliberatelyMerge() throws Exception {
        Run run = run("key-query");
        run.enter("key-query");
        assertEquals(2.0, run.eval("count(/data/items/item)"));
        for (int index = 1; index <= 2; index++) {
            run.answer("/data/items/item[" + index + "]/answer", "Visit " + index);
            run.answer("/data/items/item[" + index + "]/key", " Shared ");
        }
        String expected = "nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b: Shared ";
        assertEquals(expected, run.eval("/data/items/item[1]/__nova_operations/create_visit/case/@case_id"));
        assertEquals(expected, run.eval("/data/items/item[2]/__nova_operations/create_visit/case/@case_id"));
        run.apply();
        assertEquals(4, run.sandbox.getCaseStorage().getNumRecords());
        assertEquals("Visit 2", run.record(expected).getName());
    }
    @Test public void dynamicLinkTargetRefusals() throws Exception {
        Run good = run("link");
        good.answer("/data/destination", "patient-2");
        good.apply();
        assertEquals("patient-2", good.record("patient-1").getIndices().get(0).getTarget());
        for (String bad : new String[]{"missing", "visit-1", "patient-1"}) {
            Run run = run("link");
            run.answer("/data/destination", bad);
            assertThrows("Reject absent, wrong-type and self targets: " + bad, InvalidStructureException.class, run::apply);
        }
    }
    @Test public void nestedMenuSelectsChildDatum() throws Exception {
        Run run = run("nested");
        run.apply();
        assertEquals("Original name", run.record("patient-1").getPropertyString("nickname"));
        assertEquals("Household value", run.record("household-1").getPropertyString("nickname"));
        assertEquals("Old nickname", run.record("patient-2").getPropertyString("nickname"));
    }
    @Test public void relationUsesCandidatePropertiesAndSelectedParent() throws Exception {
        Run run = run("relation");
        run.answer("/data/answer", "Visit 2");
        run.apply();
        assertEquals("Old nickname", run.record("patient-1").getPropertyString("nickname"));
        run.answer("/data/answer", "Visit 1");
        run.apply();
        assertEquals("Matched child", run.record("patient-1").getPropertyString("nickname"));
        assertEquals("Old nickname", run.record("patient-2").getPropertyString("nickname"));
    }
    @Test public void scalarNormalizationAndBounds() throws Exception {
        for (String value : new String[]{"\t Alice  Smith \r\n", "\u00a0Alice\u2003", "😀".repeat(127) + "x"}) {
            Run run = run("scalar");
            run.answer("/data/answer", value);
            run.answer("/data/destination", "  owner-2  ");
            run.answer("/data/key", "  External/42  ");
            run.apply();
            assertEquals(value.trim(), run.record("patient-1").getName());
            assertEquals("owner-2", run.record("patient-1").getUserId());
            assertEquals("External/42", run.record("patient-1").getExternalId());
        }
        Run clear = run("scalar");
        clear.answer("/data/answer", "Valid name");
        clear.answer("/data/destination", "owner-2");
        clear.answer("/data/key", " \t ");
        clear.apply();
        assertEquals("", clear.record("patient-1").getExternalId());
        for (String path : new String[]{"answer", "destination", "key"}) {
            for (String value : new String[]{"x".repeat(256), "😀".repeat(128)}) {
                Run run = run("scalar");
                run.answer("/data/answer", "Valid name");
                run.answer("/data/destination", "owner-2");
                run.answer("/data/" + path, value);
                assertThrows(InvalidStructureException.class, run::apply);
            }
        }
        for (String path : new String[]{"answer", "destination"}) {
            Run run = run("scalar");
            run.answer("/data/answer", "Valid name");
            run.answer("/data/destination", "owner-2");
            run.answer("/data/" + path, " \t ");
            assertThrows(InvalidStructureException.class, run::apply);
        }
    }
}
