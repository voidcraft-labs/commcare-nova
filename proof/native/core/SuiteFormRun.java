package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Hashtable;
import java.util.Map;
import java.util.Set;
import org.commcare.cases.instance.CaseInstanceTreeElement;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionInstanceBuilder;
import org.commcare.suite.model.ComputedDatum;
import org.commcare.suite.model.EntityDatum;
import org.commcare.suite.model.Entry;
import org.commcare.suite.model.SessionDatum;
import org.commcare.suite.model.Suite;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.Constants;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.DateData;
import org.javarosa.core.model.data.DecimalData;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.data.IntegerData;
import org.javarosa.core.model.data.SelectOneData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.data.helper.Selection;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

/**
 * One form of a case family document, opened as a worker opens it: from its entry in the suite (Nova's local suite
 * or HQ's), each case the entry asks for chosen from the list its datum's nodeset gives, each value it works out
 * computed by Core's session, then the form initialized over that session and the seeded cases, every question
 * answered as form entry answers it (a select's first choice, a number 3, a date, a text naming its question),
 * each repeat given {@link #ROWS} rows, and the submission applied by Core's case transaction parser to the same
 * storage. Its seeded cases come from the producer's {@code <name>.cases.json}; the worker is {@link #WORKER}.
 */
final class SuiteFormRun {
    static final String WORKER = "worker-id";
    static final int ROWS = 2;
    private static final class Parser extends SuiteParser {
        Parser(InputStream in) throws IOException { super(in, null, "advanced-proof", null, true, true, false); }
    }

    final MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
    final CommCareSession session;
    final FormParseInit parsed;
    final FormDef form;
    final Map<String, Integer> rows = new HashMap<>();
    /** The ids of the cases {@link #seed} wrote, which the submission did not make. */
    final Set<String> seeded = new HashSet<>();
    private final TestInstanceInitializer runtime;

    SuiteFormRun(String family, String name, boolean hq, String formFile, String xmlns) throws Exception {
        seed("/" + family + "/" + name + ".cases.json");
        Suite suite;
        try (InputStream in = SuiteFormRun.class.getResourceAsStream("/" + family + "/" + name + (hq ? ".hq-suite.xml" : ".suite.xml"))) {
            assertNotNull("The case family holds no suite for " + name + " (hq=" + hq + ")", in);
            suite = new Parser(in).parse();
        }
        Entry entry = null;
        String command = null;
        for (Map.Entry<String, Entry> each : suite.getEntries().entrySet()) {
            if (xmlns.equals(each.getValue().getXFormNamespace())) { entry = each.getValue(); command = each.getKey(); }
        }
        assertNotNull("The suite of " + name + " has no entry for the form " + xmlns + " (hq=" + hq + ")", entry);
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        session = new CommCareSession(platform);
        session.setCommand(command);
        runtime = new TestInstanceInitializer(sandbox) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (CaseInstanceTreeElement.MODEL_NAME.equals(instance.getInstanceId())) {
                    // A list's index predicate ([index/parent = ...]) reads Core's case-index table.
                    return new ConcreteInstanceRoot(new CaseInstanceTreeElement(instance.getBase(),
                        sandbox.getCaseStorage(), new StorageCaseIndexTable(sandbox.getCaseStorage())));
                }
                if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                TreeElement root = SessionInstanceBuilder.getSessionInstance(session.getFrame(), "device", "1", 0L,
                    "worker", WORKER, new Hashtable<>(), "400", "en");
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), instance.getBase());
                return new ConcreteInstanceRoot(root);
            }
        };
        int steps = 0;
        for (SessionDatum datum = session.getNeededDatum(); datum != null; datum = session.getNeededDatum()) {
            if (++steps > 20) throw new AssertionError("The entry of " + xmlns + " kept asking for datums");
            EvaluationContext context = session.getEvaluationContext(runtime);
            if (datum instanceof ComputedDatum) {
                session.setComputedDatum(context);
            } else if (datum instanceof EntityDatum) {
                String chosen = null;
                for (TreeReference ref : context.expandReference(((EntityDatum)datum).getNodeset())) {
                    chosen = (String)context.resolveReference(ref).getAttribute(null, "case_id").getValue().getValue();
                    break;
                }
                assertNotNull("The list of " + datum.getDataId() + " in " + xmlns + " offers no seeded case (hq=" + hq + ")", chosen);
                session.setEntityDatum(datum.getDataId(), chosen);
            } else {
                throw new AssertionError("The entry of " + xmlns + " asks for " + datum.getClass().getSimpleName()
                    + " " + datum.getDataId() + ", which a worker's own choice does not give");
            }
        }
        parsed = new FormParseInit("/" + family + "/" + formFile);
        form = parsed.getFormDef();
        form.initialize(true, runtime);
    }

    private void seed(String resource) throws Exception {
        try (InputStream input = SuiteFormRun.class.getResourceAsStream(resource)) {
            assertNotNull("The case family holds no seeded cases " + resource, input);
            JSONArray cases = new JSONArray(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            for (int i = 0; i < cases.length(); i++) {
                JSONObject seed = cases.getJSONObject(i);
                Case record = new Case(seed.getString("name"), seed.getString("type"));
                record.setCaseId(seed.getString("id"));
                record.setUserId(WORKER);
                JSONObject properties = seed.optJSONObject("properties");
                if (properties != null) for (String key : properties.keySet()) record.setProperty(key, properties.getString(key));
                JSONArray indices = seed.optJSONArray("indices");
                if (indices != null) for (int j = 0; j < indices.length(); j++) {
                    JSONObject index = indices.getJSONObject(j);
                    record.setIndex(new CaseIndex(index.getString("name"), index.getString("type"), index.getString("target"), index.getString("relationship")));
                }
                sandbox.getCaseStorage().write(record);
                seeded.add(record.getCaseId());
            }
        }
    }

    /** Every question answered and every repeat given its rows, in form entry's order. */
    SuiteFormRun fill() throws Exception {
        FormEntryController controller = parsed.getFormEntryController();
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        int steps = 0;
        int answered = 0;
        int event;
        while ((event = controller.stepToNextEvent()) != FormEntryController.EVENT_END_OF_FORM) {
            if (++steps > 400) throw new AssertionError("Form entry did not terminate");
            FormIndex index = controller.getModel().getFormIndex();
            if (event == FormEntryController.EVENT_PROMPT_NEW_REPEAT) {
                String repeat = index.getReference().genericize().toString(false);
                int made = rows.getOrDefault(repeat, 0);
                if (made < ROWS) {
                    controller.newRepeat();
                    rows.put(repeat, made + 1);
                }
                continue;
            }
            if (event != FormEntryController.EVENT_QUESTION) continue;
            FormEntryPrompt prompt = controller.getModel().getQuestionPrompt();
            IAnswerData answer = answerFor(prompt, ++answered);
            if (answer == null) continue;
            assertEquals("Form entry refuses the answer to " + index.getReference(),
                FormEntryController.ANSWER_OK, controller.answerQuestion(index, answer));
        }
        return this;
    }

    private static IAnswerData answerFor(FormEntryPrompt prompt, int ordinal) {
        if (prompt.getControlType() == Constants.CONTROL_TRIGGER) return null;
        switch (prompt.getDataType()) {
            case Constants.DATATYPE_CHOICE: {
                SelectChoice first = prompt.getSelectChoices().get(0);
                return new SelectOneData(new Selection(first));
            }
            case Constants.DATATYPE_INTEGER: return new IntegerData(3);
            case Constants.DATATYPE_DECIMAL: return new DecimalData(3.0);
            case Constants.DATATYPE_DATE: return new DateData(new java.util.Date(1767225600000L));
            case Constants.DATATYPE_NULL: return null;
            default: return new StringData("Answer " + ordinal);
        }
    }

    /** What the form holds at {@code path} as text, through Core's own evaluation. */
    String value(String path) throws Exception {
        Object found = ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(" + path + ")");
        return found == null ? "" : found.toString();
    }

    double count(String path) throws Exception {
        return ((Number)ExprEvalUtils.xpathEval(form.getEvaluationContext(), "count(" + path + ")")).doubleValue();
    }

    String datum(String id) { return session.getData().get(id); }

    byte[] submission() throws Exception {
        form.postProcessInstance();
        return new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
    }

    void apply() throws Exception {
        XmlFormRecordProcessor.process(sandbox, new ByteArrayInputStream(submission()));
    }

    Case record(String id) { return sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, id); }

    /** The cases the submission made, without the seeded ones. */
    java.util.List<Case> made() {
        java.util.List<Case> found = new java.util.ArrayList<>();
        for (Case record : records()) if (!seeded.contains(record.getCaseId())) found.add(record);
        return found;
    }

    /** Every case the storage holds, the seeded ones among them. */
    java.util.List<Case> records() {
        java.util.List<Case> found = new java.util.ArrayList<>();
        for (org.javarosa.core.services.storage.IStorageIterator<Case> each = sandbox.getCaseStorage().iterate(); each.hasMore();) {
            found.add(each.nextRecord());
        }
        return found;
    }
}
