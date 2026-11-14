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
 * alike, each host under both values of `afterSubmit` the rules admit for it (the producer writes each document
 * again with each list's other value wherever Nova's gate admits it, `<document>-other-returns`). For each case list
 * that always offers another menu's registration form (`<document>.offers.json`), the action on the host's short
 * detail opens the form in its own menu with `return_to` naming the host, and on finishing the form, with the case
 * created and without, the worker lands where Preview lands them
 * (`caseListRegisterAction.ts::alwaysOfferedRegistrationReturn`, the return frame whose guard holds read by
 * `frameLanding.ts::screenOfFrame`): on that frame's screen, with the new case chosen exactly where that frame
 * selects in the host; where the form's own after-submit is in force, where that frame lands, since HQ writes no
 * return frame then. The new case is written to Core's in-memory case storage to stand for the submitted form's; no
 * form is entered and no submission is processed. */
public class RegisterFromListRuntimeTest {
 private static final String[] DOCUMENTS={"register-from-case-list","register-from-case-list-web-apps","register-from-case-list-other-returns","register-from-case-list-web-apps-other-returns"};
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
    JSONObject landing=offer.getJSONObject(created?"created":"notCreated");
    String expected=landing.isNull("command")?null:landing.getString("command"),landed=session.getCommand();
    // A bare case list's menu is its list, which its case list entry's command also opens.
    if(offer.getBoolean("hostIsBareCaseList")&&host.equals(expected))assertTrue(label+" landed on "+landed,host.equals(landed)||(host+"-case-list").equals(landed));
    else assertEquals(label,expected,landed);
    if(landing.has("selectsHost"))assertEquals(label,landing.getBoolean("selectsHost"),session.getData().containsValue(newCase));
   }
  }
 }
}
