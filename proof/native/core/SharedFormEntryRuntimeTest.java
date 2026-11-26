package nova.compatibility;

import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import org.commcare.suite.model.EntityDatum;
import org.commcare.suite.model.SessionDatum;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.TreeReference;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/** Execute each command through Core's own session, then apply the shared
 * parent XForm. Only the patient selection is the target of the parent's write. */
@RunWith(Parameterized.class)
public class SharedFormEntryRuntimeTest {
    private static final String NAME = "shared-visit-entries";
    private final boolean hq;

    @Parameterized.Parameters(name = "HQ={0}")
    public static Collection<Object[]> suites() {
        return Arrays.asList(new Object[][]{{false}, {true}});
    }

    public SharedFormEntryRuntimeTest(boolean hq) { this.hq = hq; }

    private void submit(String command, String[] tags, String[] cases, String expected) throws Exception {
        JSONArray forms = AdvancedFormRuntimeTest.app(NAME).getJSONArray("modules").getJSONObject(0).getJSONArray("forms");
        String namespace = forms.getJSONObject(0).getString("xmlns");
        String resource = NAME + ".m0f0" + (hq ? ".hq.xml" : ".xml");
        SuiteFormRun run = new SuiteFormRun("case", NAME, hq, resource, namespace, command, row -> {}, (session, runtime, entry) -> {
            assertEquals(namespace, entry.getXFormNamespace());
            for (int i = 0; i < tags.length; i++) {
                SessionDatum datum = session.getNeededDatum();
                assertTrue("Expected the list for " + tags[i], datum instanceof EntityDatum);
                assertEquals("case_id_" + tags[i], datum.getDataId());
                EvaluationContext context = session.getEvaluationContext(runtime);
                Set<String> offered = new HashSet<>();
                for (TreeReference ref : context.expandReference(((EntityDatum)datum).getNodeset())) {
                    offered.add((String)context.resolveReference(ref).getAttribute(null, "case_id").getValue().getValue());
                }
                assertEquals(new HashSet<>(Arrays.asList("person-1", "person-2", "person-3")), offered);
                session.setEntityDatum(datum.getDataId(), cases[i]);
            }
            assertNull(session.getNeededDatum());
        }).fill();
        String note = run.value("/data/visit_note");
        assertFalse(note.isEmpty());
        run.apply();
        for (String id : Arrays.asList("person-1", "person-2", "person-3")) {
            if (expected.equals(id)) assertEquals(note, run.record(id).getPropertyString("visit_note"));
            else assertNull(run.record(id).getProperty("visit_note"));
        }
    }

    @Test public void parentWritesTheLastSelectedPerson() throws Exception {
        submit("m0-f0", new String[]{"referrer","patient"}, new String[]{"person-2","person-1"}, "person-1");
    }

    @Test public void referralWritesTheFirstPersonAndAsksForAReadOnlyContact() throws Exception {
        submit("m0-f1", new String[]{"patient","contact","referrer"}, new String[]{"person-2","person-1","person-3"}, "person-2");
    }

    @Test public void callbackOmitsAnUnusedParentSelection() throws Exception {
        submit("m0-f2", new String[]{"patient"}, new String[]{"person-3"}, "person-3");
    }
}
