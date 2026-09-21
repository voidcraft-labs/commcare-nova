package nova.compatibility;

import org.junit.Test;
import static org.junit.Assert.*;

/** Local CCZ form through Core evaluation and case processing, not HQ import. */
public class OperationRelevanceRuntimeTest {
    @Test public void irrelevantAnswersAreBlankAndIrrelevantRepeatsDoNotCreate() throws Exception {
        for (boolean participates : new boolean[]{false, true}) {
            CaseOperationRuntimeTest.Run run = new CaseOperationRuntimeTest.Run("relevance", false);
            run.answer("/data/external_code", "yes");
            run.enter("repeat");
            assertEquals(1.0, run.eval("count(/data/visits)"));
            if (!participates) run.answer("/data/external_code", "no");
            run.apply();
            assertEquals(participates ? "pending" : "", run.record("patient-1").getPropertyString("op_status"));
            assertEquals("kept", run.record("patient-1").getPropertyString("visit_note"));
            assertEquals(participates ? 4 : 3, run.sandbox.getCaseStorage().getNumRecords());
        }
    }
}
