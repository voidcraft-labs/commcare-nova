package nova.compatibility;

import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.util.mocks.*;
import org.javarosa.core.model.condition.EvaluationContext;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Run G3: Core's own Register action and return frames, by host shape, on Nova's local suite and on HQ's build
 * alike. For each case list that always offers another menu's registration form (the producer's
 * `<document>.offers.json`), the action on the host's short detail opens the form in its own menu with `return_to`
 * naming the host, and on finishing the form the worker lands where Nova says
 * (`menuForms.ts::caseListRegistrationReturnOf`): back on the host with no case chosen for `case-list`; on the host
 * with the new case chosen for `new-case` where the form created it and the host has forms to go on to, and back on
 * the host with no case chosen otherwise, a bare case list among them; where the form's own after-submit is in
 * force, where that says, since HQ writes no return frame then. The new case is written to Core's in-memory case
 * storage to stand for the submitted form's; no form is entered and no submission is processed. */
public class RegisterFromListRuntimeTest {
 private static final String[] DOCUMENTS={"register-from-case-list","register-from-case-list-web-apps"};
 /** The id of the case the form's entry creates: its computed `case_id_new_<type>_0` datum. */
 private static String newCaseDatum(Suite suite,String command){
  for(SessionDatum datum:suite.getEntry(command).getSessionDataReqs())
   if(datum instanceof ComputedDatum&&datum.getDataId().startsWith("case_id_new_"))return datum.getDataId();
  fail(command+" creates no case from its entry");return null;
 }
 @Test public void registerOpensTheFormAndReturnsWhereItsHostSays()throws Exception{
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   Suite suite=MenuScreensRuntimeTest.suite(document,hq);
   JSONArray offers=MenuScreensRuntimeTest.json("/menu-screens/"+document+".offers.json").getJSONArray("offers");
   assertTrue(document,offers.length()>0);
   for(int i=0;i<offers.length();i++)for(boolean created:new boolean[]{true,false}){
    JSONObject offer=offers.getJSONObject(i);
    String host=offer.getString("hostMenuId"),command=offer.getString("formCommand"),returnTo=offer.getString("returnTo");
    String label=document+" host="+host+" return="+returnTo+" created="+created+" hq="+hq;
    MockUserDataSandbox sandbox=MockDataUtils.getStaticStorage();
    SessionWrapper session=MenuScreensRuntimeTest.session(suite,sandbox);
    Detail detail=suite.getDetail(host+"_case_short");assertNotNull(label,detail);
    EvaluationContext context=session.getEvaluationContext();
    Vector<Action> actions=detail.getCustomActions(context);assertEquals(label,1,actions.size());
    session.executeStackOperations(actions.firstElement().getStackOperations(),context);
    assertEquals(label,command,session.getCommand());
    assertEquals(label,host,session.getData().get("return_to"));
    String datum=newCaseDatum(suite,command),newCase=session.getData().get(datum);
    assertNotNull(label,newCase);assertTrue(label,newCase.matches("[0-9a-f-]{36}"));
    assertNull(label,session.getNeededData(session.getEvaluationContext()));
    if(created){
     String type=datum.substring("case_id_new_".length(),datum.lastIndexOf('_'));
     Case c=new Case("new",type);c.setCaseId(newCase);sandbox.getCaseStorage().write(c);
    }
    session.finishExecuteAndPop(session.getEvaluationContext());
    if(returnTo.equals("own")){
     String lands=offer.isNull("formLandsOn")?null:offer.getString("formLandsOn");
     assertEquals(label,lands,session.getCommand());
     continue;
    }
    String landed=session.getCommand();
    if(offer.getBoolean("hostHasForms"))assertEquals(label,host,landed);
    else assertTrue(label+" landed on "+landed,host.equals(landed)||(host+"-case-list").equals(landed));
    boolean goesOn=returnTo.equals("new-case")&&created&&offer.getBoolean("hostHasForms");
    assertEquals(label,goesOn,session.getData().containsValue(newCase));
   }
  }
 }
}
