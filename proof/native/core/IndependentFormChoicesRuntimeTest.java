package nova.compatibility;

import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;
import org.commcare.session.CommCareSession;
import org.commcare.suite.model.ComputedDatum;
import org.commcare.suite.model.EntityDatum;
import org.commcare.suite.model.Entry;
import org.commcare.suite.model.SessionDatum;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.TreeReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/** Real Core entry, back-stack and case-transaction handling over each build path. */
@RunWith(Parameterized.class)
public class IndependentFormChoicesRuntimeTest {
    private static final String NAME = "independent-form-choices";
    private final boolean hq;

    @Parameterized.Parameters(name = "HQ={0}")
    public static Collection<Object[]> paths() { return Arrays.asList(new Object[][]{{false}, {true}}); }
    public IndependentFormChoicesRuntimeTest(boolean hq) { this.hq = hq; }

    private static SessionDatum nextInput(CommCareSession session, TestInstanceInitializer runtime) {
        SessionDatum datum;
        int steps = 0;
        while ((datum = session.getNeededDatum()) instanceof ComputedDatum) {
            if (++steps > 12) throw new AssertionError("The entry kept asking for computed values");
            session.setComputedDatum(session.getEvaluationContext(runtime));
        }
        return datum;
    }

    private static void choose(CommCareSession session, TestInstanceInitializer runtime, String expected, String id)
            throws Exception {
        SessionDatum datum = nextInput(session, runtime);
        assertTrue("Expected a worker choice for " + expected, datum instanceof EntityDatum);
        assertEquals(expected, datum.getDataId());
        EvaluationContext context = session.getEvaluationContext(runtime);
        Set<String> offered = new LinkedHashSet<>();
        for (TreeReference ref : context.expandReference(((EntityDatum)datum).getNodeset()))
            offered.add((String)context.resolveReference(ref).getAttribute(null, "case_id").getValue().getValue());
        assertEquals(new LinkedHashSet<>(Arrays.asList("person-1", "person-2", "person-3", "person-4")), offered);
        session.setEntityDatum(expected, id);
    }

    private static void revisit(CommCareSession session, TestInstanceInitializer runtime, Entry entry) throws Exception {
        choose(session, runtime, "case_id_first", "person-1");
        choose(session, runtime, "case_id_second", "person-2");
        assertNull(nextInput(session, runtime));
        String oldKey = session.getData().get("visit_key");
        assertNotNull(oldKey);
        assertFalse(oldKey.isEmpty());
        assertEquals("worker-case", session.getData().get("case_id_raw"));
        assertFalse(entry.getAssertions().getAssertionsXPaths().isEmpty());
        assertNull(entry.getAssertions().getAssertionFailure(session.getEvaluationContext(runtime)));

        session.stepBack(session.getEvaluationContext(runtime));
        assertEquals("case_id_second", session.getNeededDatum().getDataId());
        session.stepBack(session.getEvaluationContext(runtime));
        assertEquals("case_id_first", session.getNeededDatum().getDataId());
        assertNull(session.getData().get("visit_key"));
        choose(session, runtime, "case_id_first", "person-3");
        choose(session, runtime, "case_id_second", "person-4");
        assertNull(nextInput(session, runtime));
        assertEquals("worker-case", session.getData().get("case_id_raw"));
        assertNotEquals(oldKey, session.getData().get("visit_key"));
        assertNull(entry.getAssertions().getAssertionFailure(session.getEvaluationContext(runtime)));
    }

    @Test public void backSkipsTheOnlyMatchingContactWhenTheEntryHasNoConfirmation() throws Exception {
        JSONObject form = AdvancedFormRuntimeTest.app(NAME).getJSONArray("modules").getJSONObject(0)
            .getJSONArray("forms").getJSONObject(1);
        String file = NAME + ".m0f1" + (hq ? ".hq.xml" : ".xml");
        new SuiteFormRun("case", NAME, hq, file, form.getString("xmlns"), record -> {
            if ("person-1".equals(record.getCaseId())) record.setName("Ada");
        }, (session, runtime, entry) -> {
            choose(session, runtime, "case_id_person", "person-2");
            EntityDatum contact = (EntityDatum)nextInput(session, runtime);
            assertEquals("case_id_contact", contact.getDataId());
            assertNull(contact.getLongDetail());
            EvaluationContext context = session.getEvaluationContext(runtime);
            TreeReference automatic = contact.getCurrentAutoselectableCase(context);
            assertNotNull(automatic);
            String id = (String)context.resolveReference(automatic).getAttribute(null, "case_id").getValue().getValue();
            assertEquals("person-1", id);
            session.setEntityDatum(contact.getDataId(), id);
            assertNull(nextInput(session, runtime));
            session.stepBack(session.getEvaluationContext(runtime));
            assertEquals("case_id_person", session.getNeededDatum().getDataId());
            choose(session, runtime, "case_id_person", "person-3");
            session.setEntityDatum(contact.getDataId(), id);
        });
    }

    @Test public void backingUpClearsLaterValuesAndSubmissionUsesTheNewPair() throws Exception {
        JSONObject form = AdvancedFormRuntimeTest.app(NAME).getJSONArray("modules").getJSONObject(0)
            .getJSONArray("forms").getJSONObject(0);
        String file = NAME + ".m0f0" + (hq ? ".hq.xml" : ".xml");
        SuiteFormRun run = new SuiteFormRun("case", NAME, hq, file, form.getString("xmlns"), record -> {},
            IndependentFormChoicesRuntimeTest::revisit).fill();
        assertEquals("Before", run.value("/data/earlier_value"));
        assertEquals(run.record("person-3").getName(), run.value("/data/first_record"));
        assertEquals(run.record("person-4").getName(), run.value("/data/starting_record"));
        String note = run.value("/data/note");
        assertFalse(note.isEmpty());
        run.apply();
        assertEquals(note, run.record("person-3").getPropertyString("first_note"));
        assertEquals(note, run.record("person-4").getPropertyString("second_note"));
        for (String id : Arrays.asList("person-1", "person-2")) {
            assertNull(run.record(id).getProperty("first_note"));
            assertNull(run.record(id).getProperty("second_note"));
        }
    }
    @Test public void lateValuesCascadeAndDoNotRunAgainInARepeatsNewRow() throws Exception {
        JSONObject source = AdvancedFormRuntimeTest.app(NAME).getJSONArray("modules").getJSONObject(2)
            .getJSONArray("forms").getJSONObject(0);
        String file = NAME + ".m2f0" + (hq ? ".hq.xml" : ".xml");
        SuiteFormRun run = new SuiteFormRun("case", NAME, hq, file, source.getString("xmlns"));
        String visitor = run.record(run.datum("case_id")).getName();
        assertEquals(visitor, run.value("/data/visitor"));
        assertEquals("Visit " + visitor + " confirmed", run.value("/data/second_copy"));
        assertEquals("Checked: Visit " + visitor + " confirmed", run.value("/data/confirmation"));
        assertEquals("Seen: ", run.value("/data/earlier_description"));
        assertEquals("Ready", run.value("/data/details/description"));
        assertEquals(0, run.count("/data/zero"), 0);
        run.fill();
        assertEquals(0, run.count("/data/zero"), 0);
        assertEquals(1, run.count("/data/one"), 0);
        assertEquals("", run.value("/data/one[1]/copy"));
    }

}
