package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.modern.util.Pair;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.util.mocks.*;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Core's own Register action and return frames, by host shape, on Nova's local suite and on HQ's build
 * alike, each host under both values of `afterSubmit` the rules admit for it (the producer writes each document
 * again with each list's other value wherever Nova's gate admits it, `<document>-other-returns`). For each case list
 * that always offers another menu's registration form (`<document>.offers.json`), the action on the host's short
 * detail opens the form in its own menu with `return_to` naming the host, and on finishing the form, with the case
 * created and without, the worker lands where Preview lands them
 * (`caseListRegisterAction.ts::caseListActionReturn`, the return frame whose guard holds read by
 * `frameLanding.ts::screenOfFrame`): on that frame's screen, with the new case chosen exactly where that frame
 * selects in the host; where the form's own after-submit is in force, where that frame lands, since HQ writes no
 * return frame then. The new case is written to Core's in-memory case storage to stand for the submitted form's; no
 * form is entered and no submission is processed. */
public class RegisterFromListRuntimeTest {
 private static final String[] DOCUMENTS={"first-menu-registration","register-from-case-list","register-from-case-list-web-apps","register-from-case-list-other-returns","register-from-case-list-web-apps-other-returns"};
 /** The id of the case the form's entry creates: its computed `case_id_new_<type>_0` datum. */
 private static String newCaseDatum(Suite suite,String command){
  for(SessionDatum datum:suite.getEntry(command).getSessionDataReqs())
   if(datum instanceof ComputedDatum&&datum.getDataId().startsWith("case_id_new_"))return datum.getDataId();
  fail(command+" creates no case from its entry");return null;
 }
 /** The list's actions that open `command`: a host whose list also searches carries the search's action beside the
  * Register action (`details.py::DetailContributor.get_case_search_action`). */
 private static List<Action> opening(Vector<Action> actions,String command,EvaluationContext context){
  List<Action> found=new ArrayList<>();
  for(Action action:actions)ops:for(StackOperation op:action.getStackOperations())for(StackFrameStep step:op.getStackFrameSteps())
   if(SessionFrame.STATE_COMMAND_ID.equals(step.getType())&&command.equals(step.evaluateValue(context))){found.add(action);break ops;}
  return found;
 }
 /** Bring the session to the host's case list as a worker reaches it, since the Register action runs there and the
  * return frame copies what the worker chose on the way (a child list's `parent_id`): the entry that lists the
  * host's cases (`<host>_case_short`) chosen, each value it asks for ahead of that list given (a case for an earlier
  * selection, an inline search answered with an empty result set as `MenuScreensRuntimeTest.fill` answers it), until
  * the selection it needs is the host's list. */
 private static void openHostList(SessionWrapper session,Suite suite,String host,String label)throws Exception{
  openHostList(session, suite, host, label, null);
 }
 private static void openHostList(SessionWrapper session, Suite suite, String host, String label, String parentId) throws Exception {
  String list=host+"_case_short";TreeSet<String> listing=new TreeSet<>();
  for(Entry entry:suite.getEntries().values())for(SessionDatum datum:entry.getSessionDataReqs())
   if(datum instanceof EntityDatum&&list.equals(((EntityDatum)datum).getShortDetail()))listing.add(entry.getCommandId());
  assertFalse(label+": no entry lists "+list,listing.isEmpty());
  session.setCommand(listing.first());
  for(int step=0;;step++){
   assertTrue(label+" asks for more than ten values before "+list,step<10);
   EvaluationContext context=session.getEvaluationContext();
   String needed=session.getNeededData(context);
   assertNotNull(label+" never shows "+list,needed);
   SessionDatum datum=needed.equals(SessionFrame.STATE_COMMAND_ID)?null:session.getNeededDatum();
   if(datum instanceof EntityDatum&&list.equals(((EntityDatum)datum).getShortDetail()))return;
   if(needed.equals(SessionFrame.STATE_QUERY_REQUEST)){
    RemoteQuerySessionManager manager=RemoteQuerySessionManager.buildQuerySessionManager(session,context,new ArrayList<>());
    assertNotNull(label,manager);
    Pair<ExternalDataInstance,String> results=manager.buildExternalDataInstance(new ByteArrayInputStream("<results/>".getBytes(StandardCharsets.UTF_8)),"menu-screens-proof",com.google.common.collect.ArrayListMultimap.create());
    assertNotNull(label+": "+results.second,results.first);
    session.setQueryDatum(results.first);
   }
   else if(needed.equals(SessionFrame.STATE_DATUM_VAL))session.setEntityDatum(datum.getDataId(),parentId == null ? "chosen-"+datum.getDataId() : parentId);
   else if(needed.equals(SessionFrame.STATE_DATUM_COMPUTED))session.setComputedDatum(context);
   else fail(label+" needs "+needed+" before "+list);
  }
 }
 /** Where Preview lands a worker who opened the host's list action and finished the form with no case created
  * (`<document>.offers.json`). */
 private static String landingOf(String document,String host)throws Exception{
  JSONArray offers=MenuScreensRuntimeTest.json("/menu-screens/"+document+".offers.json").getJSONArray("offers");
  for(int i=0;i<offers.length();i++){
   JSONObject offer=offers.getJSONObject(i);
   if(!host.equals(offer.getString("hostMenuId")))continue;
   JSONObject landing=offer.getJSONObject("notCreated");
   return landing.isNull("command")?null:landing.getString("command");
  }
  fail(document+" offers no form on "+host);return null;
 }
 @Test public void exactCreatedMemberAndChosenHouseholdDriveTheirOwnListActions() throws Exception {
  for (String shape : new String[]{"basic","advanced"}) for (boolean hq : new boolean[]{false,true}) {
   Suite suite = MenuScreensRuntimeTest.suite("case-list-action-roles-"+shape, hq);
   for (boolean followUp : new boolean[]{false,true}) for (boolean wroteMember : new boolean[]{false,true}) {
    String host = followUp ? "m2" : "m1", command = followUp ? "m3-f0" : "m3-f1";
    String label = shape+" hq="+hq+" host="+host+" wrote="+wroteMember;
    MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
    SessionWrapper session = MenuScreensRuntimeTest.session(suite,sandbox);
    if (!followUp) {
     SessionWrapper closed = MenuScreensRuntimeTest.session(suite, sandbox);
     openHostList(closed,suite,host,label,"closed-to-new-members");
     EvaluationContext blocked = closed.getEvaluationContext();
     assertTrue(label+" the selected household hides the action",
       opening(suite.getDetail(host+"_case_short").getCustomActions(blocked),command,blocked).isEmpty());
    }
    openHostList(session,suite,host,label);
    List<String> previous = new ArrayList<>();
    for (String value : session.getData().values()) if (value.startsWith("chosen-")) previous.add(value);
    assertEquals(label,1,previous.size());
    EvaluationContext context = session.getEvaluationContext();
    List<Action> shown = opening(suite.getDetail(host+"_case_short").getCustomActions(context),command,context);
    assertEquals(label,1,shown.size());
    session.executeStackOperations(shown.get(0).getStackOperations(),context);
    assertEquals(label,host,session.getData().get("return_to"));
    assertNull(label,session.getNeededData(session.getEvaluationContext()));
    if (followUp) {
     for (SessionDatum datum : suite.getEntry(command).getSessionDataReqs())
      if (datum instanceof EntityDatum) assertEquals(label,previous.get(0),session.getData().get(datum.getDataId()));
     session.finishExecuteAndPop(session.getEvaluationContext());
     // A follow-up on the chosen parent keeps its own after-submit (HQ writes no return frame for it), here
     // Previous: its entry's frame with the last selection popped, which asks for the household again.
     assertEquals(label+" the form lands where its own after-submit says",landingOf("case-list-action-roles-"+shape,host),session.getCommand());
     continue;
    }
    String member = null, household = null;
    for (SessionDatum datum : suite.getEntry(command).getSessionDataReqs()) {
     if (!(datum instanceof ComputedDatum)) continue;
     String key = datum.getDataId(), id = session.getData().get(key);
     boolean person = key.contains("person");
     assertTrue(label+" "+key, person || key.contains("household"));
     if (person) member = id; else household = id;
     // The other created case exists even where the chosen case was skipped.
     if (!person || wroteMember) {
      Case record = new Case(key,person ? "person" : "household");
      record.setCaseId(id);
      sandbox.getCaseStorage().write(record);
     }
    }
    assertNotNull(label,member);
    assertNotNull(label,household);
    session.finishExecuteAndPop(session.getEvaluationContext());
    assertEquals(label,host,session.getCommand());
    assertEquals(label,wroteMember,session.getData().containsValue(member));
    // The return opens the members of the household the form created: HQ keys the list's household datum to
    // the form's new household (`_find_best_match`), not to the one chosen before the list.
    assertEquals(label+" the return's household",household,session.getData().get("parent_id"));
   }
  }
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
    openHostList(session,suite,host,label);
    Detail detail=suite.getDetail(host+"_case_short");assertNotNull(label,detail);
    EvaluationContext context=session.getEvaluationContext();
    List<Action> register=opening(detail.getCustomActions(context),command,context);assertEquals(label,1,register.size());
    session.executeStackOperations(register.get(0).getStackOperations(),context);
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
    if(document.equals("first-menu-registration")&&created){
     session.stepBack(session.getEvaluationContext());
     assertNull(label,session.getCommand());
     session.setCommand("m0-f0");
     assertNull(label,session.getNeededData(session.getEvaluationContext()));
     assertEquals(label,newCase,session.getData().get("case_id"));
    }
   }
  }
 }
}
