package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.suite.model.*;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.model.User;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.services.storage.IStorageUtilityIndexed;
import org.javarosa.core.services.locale.Localization;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.model.xform.XPathReference;
import org.javarosa.xpath.expr.FunctionUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real SuiteParser fixture installation and CommCare fixture resolution. */
public class LookupRuntimeTest {
    private static final class Installer extends SuiteParser {
        Installer(InputStream input, IStorageUtilityIndexed<FormInstance> storage, boolean upgrade) throws IOException {
            super(input, null, "nova-lookup", storage, true, false, upgrade);
        }
    }
    private static TreeElement node(String name, String value) {
        TreeElement result = new TreeElement(name, 0);
        if (value != null) result.setValue(new StringData(value));
        return result;
    }
    private final class Runtime extends CommCareInstanceInitializer {
        final MockUserDataSandbox sandbox;
        final String username;
        Runtime(String user, String region) throws Exception {
            this(MockDataUtils.getStaticStorage(), user, region);
        }
        private Runtime(MockUserDataSandbox sandbox, String user, String region) throws Exception {
            super(sandbox);
            this.sandbox = sandbox;
            this.username = user;
            sandbox.setLoggedInUser(new User(user, "unused", "worker-" + user));
            if (sandbox.getCaseStorage().getNumRecords() == 0) for (String id : Arrays.asList("patient-1", "patient-2")) {
                Case record = new Case(id, "patient");
                record.setCaseId(id);
                record.setUserId("worker-" + user);
                record.setProperty("region", id.equals("patient-1") ? region : "south");
                sandbox.getCaseStorage().write(record);
            }
        }
        Suite install(String name, boolean upgrade) throws Exception {
            try (InputStream input = getClass().getResourceAsStream("/" + name + ".suite.xml")) {
                assertNotNull(name, input);
                return new Installer(input, sandbox.getAppFixtureStorage(), upgrade).parse();
            }
        }
        @Override protected InstanceRoot setupSessionData(ExternalDataInstance instance) {
            TreeElement session = node("session", null);
            TreeElement context = node("context", null);
            for (String key : new String[]{"deviceid", "appversion"}) context.addChild(node(key, "fixture-" + key));
            context.addChild(node("username", username));
            context.addChild(node("userid", "worker-" + username));
            context.addChild(node("drift", "0"));
            session.addChild(context);
            TreeElement data = node("data", null);
            data.addChild(node("case_id", "patient-1"));
            session.addChild(data);
            InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), instance.getBase());
            return new ConcreteInstanceRoot(session);
        }
        EvaluationContext context(Hashtable<String, DataInstance> instances) {
            for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(this, id));
            return new EvaluationContext(null, instances);
        }
        FormParseInit form(String suffix) throws Exception {
            FormParseInit parsed = new FormParseInit("/lookup-app" + suffix);
            parsed.getFormDef().initialize(true, this);
            parsed.getFormDef().getLocalizer().setLocale("en");
            return parsed;
        }
    }

    @Test public void globalFixtureStorageAndFirstRowTrackInstalledGeneration() throws Exception {
        for (String user : Arrays.asList("north", "south")) {
            Runtime runtime = new Runtime(user, "north");
            Suite first = runtime.install("lookup-app", false);
            assertEquals(1, runtime.sandbox.getAppFixtureStorage().getNumRecords());
            Menu menu = first.getMenus().firstElement();
            assertTrue(FunctionUtils.toBoolean(menu.getMenuRelevance().eval(runtime.context(menu.getInstances(null)))));
            assertEquals("Northland", ExprEvalUtils.xpathEval(runtime.form(".xml").getFormDef().getEvaluationContext(), "string(instance('regions')/regions_list/regions[1]/label)"));
            runtime.install("lookup-reversed", true);
            assertEquals(1, runtime.sandbox.getAppFixtureStorage().getNumRecords());
            // Initializers cache fixtures within a runtime. A new initializer is
            // the new app session after the completed upgrade, sharing storage.
            Runtime upgraded = new Runtime(runtime.sandbox, user, "north");
            Suite second = upgraded.install("lookup-reversed", false);
            Menu reverseMenu = second.getMenus().firstElement();
            assertFalse(FunctionUtils.toBoolean(reverseMenu.getMenuRelevance().eval(upgraded.context(reverseMenu.getInstances(null)))));
            assertEquals("Eastland", ExprEvalUtils.xpathEval(upgraded.form(".xml").getFormDef().getEvaluationContext(), "string(instance('regions')/regions_list/regions[1]/label)"));
        }
    }

    @Test public void suiteCalculatedColumnCorrelatesTheSelectedCase() throws Exception {
        Runtime runtime = new Runtime("north", "north");
        Suite suite = runtime.install("lookup-app", false);
        Entry entry = suite.getEntry("m0-f0");
        EvaluationContext context = runtime.context(entry.getInstances(null));
        Detail detail = suite.getDetail("m0_case_short");
        assertNotNull(detail);
        for (int index = 0; index < 2; index++) {
            TreeReference ref = XPathReference.getPathExpr("instance('casedb')/casedb/case[@case_id = 'patient-" + (index + 1) + "']").getReference();
            List<TreeReference> concrete = context.expandReference(ref);
            assertEquals(1, concrete.size());
            EvaluationContext row = new EvaluationContext(context, concrete.get(0));
            assertEquals(index == 0 ? "Northland" : "Southland", detail.getFields()[1].getTemplate().evaluate(row));
        }
    }

    @Test public void lookupRelationPredicatesKeepCaseAndFixtureScopesSeparate() throws Exception {
        Runtime runtime = new Runtime("north", "north");
        Suite suite = runtime.install("lookup-app", false);
        Case household = new Case("Household", "household");
        household.setCaseId("household-1");
        runtime.sandbox.getCaseStorage().write(household);
        Case patient = runtime.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1");
        patient.setIndex(new CaseIndex("parent", "household", "household-1"));
        runtime.sandbox.getCaseStorage().write(patient);
        for (int index = 1; index <= 2; index++) {
            Case visit = new Case("Visit", "visit");
            visit.setCaseId("visit-" + index);
            visit.setIndex(new CaseIndex("parent", "patient", "patient-" + index));
            visit.setProperty("outcome", index == 1 ? "open" : "closed");
            runtime.sandbox.getCaseStorage().write(visit);
        }
        EvaluationContext context = runtime.context(suite.getEntry("m0-f0").getInstances(null));
        try (BufferedReader input = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/lookup-relations.tsv"), StandardCharsets.UTF_8))) {
            String line;
            int checked = 0;
            while ((line = input.readLine()) != null) {
                String[] parts = line.split("\t", -1);
                for (int index = 1; index <= 2; index++) {
                    TreeReference ref = XPathReference.getPathExpr("instance('casedb')/casedb/case[@case_id = 'patient-" + index + "']").getReference();
                    List<TreeReference> concrete = context.expandReference(ref);
                    assertEquals(1, concrete.size());
                    EvaluationContext row = new EvaluationContext(context, concrete.get(0));
                    assertEquals(parts[0] + " patient-" + index, index == 1 ? "Northland" : "", ExprEvalUtils.xpathEval(row, "string(" + parts[1] + ")"));
                    checked++;
                }
            }
            assertEquals(4, checked);
        }
    }

    private static List<String> values(FormEntryPrompt prompt) {
        List<String> result = new ArrayList<>();
        for (SelectChoice choice : prompt.getSelectChoices()) result.add(choice.getValue() + "=" + choice.getLabelInnerText());
        return result;
    }

    @Test public void rootSessionRepeatAndMultiselectChoicesUseCurrentInputs() throws Exception {
        for (String suffix : Arrays.asList(".xml", ".hq.xml")) {
            Runtime runtime = new Runtime("south", "north");
            runtime.install("lookup-app", false);
            FormParseInit parsed = runtime.form(suffix);
            FormEntryController controller = parsed.getFormEntryController();
            controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
            int repeats = 0;
            int selections = 0;
            int steps = 0;
            while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
                if (++steps > 80) throw new AssertionError("Form did not finish");
                if (parsed.getFormEntryModel().getEvent() != FormEntryController.EVENT_QUESTION) continue;
                FormEntryPrompt prompt = parsed.getFormEntryModel().getQuestionPrompt();
                String name = prompt.getQuestion().getBind().getReference().getNameLast();
                if ("zone".equals(name)) {
                    assertEquals(FormEntryController.ANSWER_OK, controller.answerQuestion(new StringData(repeats == 0 ? "p1" : "p2")));
                } else if ("all_regions".equals(name) || "many".equals(name)) {
                    assertEquals(Arrays.asList("north=Northland", "south=Southland", "east=Eastland"), values(prompt));
                    selections++;
                } else if ("filtered".equals(name)) {
                    assertEquals(Arrays.asList("north=Northland", "east=Eastland"), values(prompt));
                    selections++;
                } else if ("session_filtered".equals(name)) {
                    assertEquals(Collections.singletonList("south=Southland"), values(prompt));
                    selections++;
                } else if ("repeat_filtered".equals(name)) {
                    assertEquals(repeats == 0 ? Arrays.asList("north=Northland", "east=Eastland") : Collections.singletonList("south=Southland"), values(prompt));
                    repeats++;
                }
            }
            assertEquals(4, selections);
            assertEquals(2, repeats);
        }
    }

    @Test public void caseOperationUsesSelectedCaseAndNoMatchStaysEmpty() throws Exception {
        for (String suffix : Arrays.asList(".xml", ".hq.xml")) for (String region : Arrays.asList("north", "south", "absent")) {
            Runtime runtime = new Runtime("east", region);
            runtime.install("lookup-app", false);
            FormDef form = runtime.form(suffix).getFormDef();
            form.postProcessInstance();
            byte[] xml = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
            XmlFormRecordProcessor.process(runtime.sandbox, new ByteArrayInputStream(xml));
            Case record = runtime.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1");
            assertEquals(region.equals("north") ? "Northland" : region.equals("south") ? "Southland" : "", record.getPropertyString("resolved"));
            assertNull(runtime.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-2").getProperty("resolved"));
        }
    }

    @Test public void missingInstalledFixtureCannotMasqueradeAsAnEmptyChoiceList() throws Exception {
        Localization.getGlobalLocalizerAdvanced().addAvailableLocale("default");
        Localization.setLocale("default");
        Runtime runtime = new Runtime("north", "north");
        try {
            runtime.form(".xml");
            fail("Missing delivered fixture must refuse initialization");
        } catch (CommCareInstanceInitializer.FixtureInitializationException expected) {
            assertEquals("jr://fixture/item-list:regions", expected.reference);
        }
    }
}
