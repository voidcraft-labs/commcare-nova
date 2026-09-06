package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
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
import org.javarosa.xpath.XPathMissingInstanceException;
import org.junit.Test;
import static org.junit.Assert.*;

/** Independent consumers prevent an unrelated property read from masking a
 * missing instance. Native storage provides case rows, never synthetic XPath. */
public class RelationInstanceRuntimeTest {
    private static TreeElement node(String name, String value) {
        TreeElement result = new TreeElement(name, 0);
        if (value != null) result.setValue(new StringData(value));
        return result;
    }

    private static class Run {
        final MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
        final FormParseInit parsed;
        final FormDef form;

        Run(String resource, int childCount) throws Exception {
            Case parent = new Case("Patient", "patient");
            parent.setCaseId("patient-1");
            parent.setUserId("owner-1");
            parent.setProperty("visit_count", "9");
            sandbox.getCaseStorage().write(parent);
            for (int index = 0; index < childCount; index++) {
                child("visit-" + index, "visit", "patient-1");
            }
            child("unrelated-visit", "visit", "patient-2");
            child("wrong-type", "household", "patient-1");
            parsed = new FormParseInit(resource);
            form = parsed.getFormDef();
            form.initialize(true, new TestInstanceInitializer(sandbox) {
                @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                    if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                    TreeElement session = node("session", null);
                    TreeElement context = node("context", null);
                    for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) {
                        context.addChild(node(key, "fixture-" + key));
                    }
                    context.addChild(node("drift", "0"));
                    TreeElement data = node("data", null);
                    data.addChild(node("case_id", "patient-1"));
                    session.addChild(context);
                    session.addChild(data);
                    InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                    return new ConcreteInstanceRoot(session);
                }
            });
        }

        void child(String id, String type, String parentId) throws Exception {
            Case record = new Case(id, type);
            record.setCaseId(id);
            record.setUserId("owner-1");
            record.setIndex(new CaseIndex("parent", "patient", parentId));
            sandbox.getCaseStorage().write(record);
        }

        String submit() throws Exception {
            FormEntryController controller = parsed.getFormEntryController();
            controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
            int steps = 0;
            while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
                if (++steps > 20) throw new AssertionError("Form entry did not terminate");
            }
            form.postProcessInstance();
            byte[] submitted = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
            XmlFormRecordProcessor.process(sandbox, new ByteArrayInputStream(submitted));
            return sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1").getPropertyString("visit_count");
        }
    }

    @Test public void retainedMissingDeclarationFailsDuringInitialization() throws Exception {
        try {
            new Run("/before-related-count-instance.xml", 2);
            fail("The pre-fix form must fail before it opens");
        } catch (XPathMissingInstanceException failure) {
            assertTrue(failure.getMessage(), failure.getMessage().contains("instance \"casedb\""));
        }
    }

    private void check(String scenario, String absent, String present) throws Exception {
        for (String suffix : Arrays.asList(".xml", ".hq.xml")) {
            String resource = "/operation-instance-" + scenario + suffix;
            assertEquals(resource + " without matching children", absent, new Run(resource, 0).submit());
            assertEquals(resource + " with two matching children", present, new Run(resource, 2).submit());
        }
    }

    @Test public void countValueDeclaresItsOwnCaseData() throws Exception { check("count", "0", "2"); }
    @Test public void countConditionDeclaresItsOwnCaseData() throws Exception { check("count-condition", "9", "1"); }
    @Test public void existsConditionDeclaresItsOwnCaseData() throws Exception { check("exists", "9", "1"); }
    @Test public void missingInsideValueDeclaresItsOwnCaseData() throws Exception { check("missing", "1", "0"); }
}
