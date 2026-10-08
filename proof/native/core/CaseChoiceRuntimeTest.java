package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.cases.instance.CaseInstanceTreeElement;
import org.commcare.cases.query.queryset.DualTableSingleMatchModelQuerySet;
import org.commcare.modern.engine.cases.CaseIndexTable;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.model.data.SelectMultiData;
import org.javarosa.core.model.data.SelectOneData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.data.helper.Selection;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.core.services.storage.IStorageIterator;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Exact IDs, candidate/selected scopes, changing answers and final-only
 * attendance effects, in Core over CCZ and HQ-generated forms. */
public class CaseChoiceRuntimeTest {
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    static final class Run {
        final MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
        final List<String[]> seeds = new ArrayList<>();
        final FormParseInit parsed;
        final FormDef form;
        final FormEntryController controller;
        Run(String name, boolean hq) throws Exception {
            for (String line : Files.readAllLines(NativeProof.familyDirectory("case-choice").resolve("cases.tsv"))) {
                String[] row = line.split("\t", -1);
                seeds.add(row);
                Case record = new Case(row[2], row[1]);
                record.setCaseId(row[0]);
                record.setUserId("worker-a");
                if (!row[3].isEmpty()) record.setIndex(new CaseIndex("parent", "clinic", row[3]));
                record.setClosed("closed".equals(row[4]));
                sandbox.getCaseStorage().write(record);
            }
            parsed = new FormParseInit("/case-choice/" + name + (hq ? ".hq.xml" : ".xml"));
            form = parsed.getFormDef();
            form.initialize(true, new TestInstanceInitializer(sandbox) {
                @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                    if ("casedb".equals(instance.getInstanceId())) return new ConcreteInstanceRoot(new CaseInstanceTreeElement(instance.getBase(), sandbox.getCaseStorage(), new CaseIndexTable() {
                        // Core's stock TestInstanceInitializer supplies no physical
                        // case-index table. Answer its storage reads from the same
                        // native Case records; Core still parses, plans and evaluates
                        // every emitted XPath and processes the submission itself.
                        public LinkedHashSet<Integer> getCasesMatchingIndex(String name, String value) {
                            LinkedHashSet<Integer> matches = new LinkedHashSet<>();
                            for (IStorageIterator it = sandbox.getCaseStorage().iterate(false); it.hasMore();) {
                                int id = it.nextID();
                                if (value.equals(sandbox.getCaseStorage().read(id).getMetaData(Case.INDEX_CASE_INDEX_PRE + name))) matches.add(id);
                            }
                            return matches;
                        }
                        public LinkedHashSet<Integer> getCasesMatchingValueSet(String name, String[] values) {
                            LinkedHashSet<Integer> matches = new LinkedHashSet<>();
                            for (String value : values) matches.addAll(getCasesMatchingIndex(name, value));
                            return matches;
                        }
                        public int loadIntoIndexTable(HashMap<String, Vector<Integer>> cache, String name) { throw new AssertionError("Unexpected bulk index read"); }
                        public DualTableSingleMatchModelQuerySet bulkReadIndexToCaseIdMatch(String name, Collection<Integer> cases) { throw new AssertionError("Unexpected bulk join"); }
                        public void indexCase(Case record) { throw new AssertionError("Unexpected index write"); }
                        public void clearCaseIndices(Collection<Integer> ids) { throw new AssertionError("Unexpected index clear"); }
                        public void delete() { throw new AssertionError("Unexpected index delete"); }
                        public boolean isStorageExists() { return true; }
                    }));
                    if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                    TreeElement session = node("session", null);
                    TreeElement context = node("context", null);
                    for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) context.addChild(node(key, "worker-a"));
                    context.addChild(node("drift", "0"));
                    session.addChild(context);
                    TreeElement data = node("data", null);
                    data.addChild(node("case_id", seeds.get(0)[0]));
                    session.addChild(data);
                    InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), instance.getBase());
                    return new ConcreteInstanceRoot(session);
                }
            });
            form.getLocalizer().setLocale("en");
            controller = parsed.getFormEntryController();
        }
        FormEntryPrompt question(String name) throws Exception {
            controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
            for (int step = 0; step < 150; step++) {
                int event = controller.stepToNextEvent();
                if (event == FormEntryController.EVENT_END_OF_FORM) break;
                if (event != FormEntryController.EVENT_QUESTION) continue;
                FormEntryPrompt prompt = parsed.getFormEntryModel().getQuestionPrompt();
                if (name.equals(prompt.getQuestion().getBind().getReference().getNameLast())) return prompt;
            }
            throw new AssertionError("Missing question " + name);
        }
        List<String> values(FormEntryPrompt prompt) {
            List<String> values = new ArrayList<>();
            for (SelectChoice choice : prompt.getSelectChoices()) values.add(choice.getValue());
            return values;
        }
        void choose(int... indexes) {
            Vector<Selection> selected = new Vector<>();
            for (int index : indexes) selected.add(new Selection(parsed.getFormEntryModel().getQuestionPrompt().getSelectChoices().get(index)));
            assertEquals(FormEntryController.ANSWER_OK, controller.answerQuestion(new SelectMultiData(selected)));
        }
    }
    @Test public void dynamicDirectoryUsesExactIdsAndCurrentEarlierAnswer() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            Run run = new Run("directory", hq);
            assertEquals(Collections.emptyList(), run.values(run.question("members")));
            FormEntryPrompt clinic = run.question("clinic");
            assertEquals(Arrays.asList(run.seeds.get(0)[0], run.seeds.get(1)[0]), run.values(clinic));
            assertEquals(FormEntryController.ANSWER_OK, run.controller.answerQuestion(new SelectOneData(new Selection(clinic.getSelectChoices().get(0)))));
            FormEntryPrompt members = run.question("members");
            assertEquals(30, members.getSelectChoices().size());
            assertEquals("Alex", members.getSelectChoices().get(0).getLabelInnerText());
            assertEquals("Alex", members.getSelectChoices().get(1).getLabelInnerText());
            assertNotEquals(members.getSelectChoices().get(0).getValue(), members.getSelectChoices().get(1).getValue());
            run.choose(0, 1);
            clinic = run.question("clinic");
            assertEquals(FormEntryController.ANSWER_OK, run.controller.answerQuestion(new SelectOneData(new Selection(clinic.getSelectChoices().get(1)))));
            assertEquals(Collections.singletonList(run.seeds.get(32)[0]), run.values(run.question("members")));
        }
    }
    @Test public void attendanceBackAndDeselectUpdatesOnlyFinalMembers() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            Run run = new Run("attendance", hq);
            assertEquals(30, run.question("attendees").getSelectChoices().size());
            run.choose(0, 1);
            run.question("ready");
            run.question("attendees");
            run.choose(1, 29);
            run.question("ready");
            assertEquals(30.0, ExprEvalUtils.xpathEval(run.form.getEvaluationContext(), "count(/data/entry/roster/item)"));
            run.form.postProcessInstance();
            byte[] xml = new XFormSerializingVisitor().serializeInstance(run.form.getMainInstance());
            XmlFormRecordProcessor.process(run.sandbox, new ByteArrayInputStream(xml));
            for (int i = 0; i < 32; i++) {
                Case record = run.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, run.seeds.get(i + 2)[0]);
                if (i == 1 || i == 29) assertEquals("present", record.getPropertyString("attendance"));
                else assertNull(record.getProperty("attendance"));
            }
        }
    }
}
