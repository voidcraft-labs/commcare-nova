package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.LoggerInterface;
import org.commcare.util.mocks.*;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.User;
import org.javarosa.core.model.condition.EvaluationContext;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Core's own menu listing, its case-first question and its after-submit frames over the menus Nova writes for
 * menus that show their forms in the menu above, on Nova's local suite and on HQ's build alike: each screen lists
 * what Nova's projection says it lists (`menuScreens.ts::menuScreenEntries`, written by the producer), in order,
 * with every display condition false (the worker holds no data a condition reads); choosing a menu asks for a case
 * first exactly where Nova says the screen chooses a case first; each form with no destinations of its own lands
 * where its after-submit says. The step-back control is the fact Nova's refusal of a frame through a first menu
 * that shares one case rests on. Core's in-memory case storage stands in for a device's; no form is entered. */
public class MenuScreensRuntimeTest {
 private static final String[] DOCUMENTS={"forms-in-menu-above","forms-in-menu-above-nested","forms-in-menu-above-registration-only","forms-in-menu-above-one-case","register-from-case-list","register-from-case-list-web-apps"};
 private static final class Parser extends SuiteParser{Parser(InputStream in)throws IOException{super(in,null,"menu-screens-proof",null,true,true,false);}}
 private static final LoggerInterface FAIL=new LoggerInterface(){
  @Override public void logError(String message,Exception cause){fail(message);}
  @Override public void logError(String message){fail(message);}
 };
 static JSONObject json(String resource)throws IOException{
  try(InputStream in=MenuScreensRuntimeTest.class.getResourceAsStream(resource)){assertNotNull(resource,in);return new JSONObject(new String(in.readAllBytes(),StandardCharsets.UTF_8));}
 }
 static Suite suite(String document,boolean hq)throws Exception{
  String resource="/menu-screens/"+document+(hq?".hq-suite.xml":".suite.xml");
  try(InputStream in=MenuScreensRuntimeTest.class.getResourceAsStream(resource)){assertNotNull(resource,in);return new Parser(in).parse();}
 }
 /** A session on the suite for a signed-in worker whose device holds the given cases, each `{id, type}`. */
 static SessionWrapper session(Suite suite,MockUserDataSandbox sandbox,String[]... cases){
  sandbox.setLoggedInUser(new User("worker","","worker-id"));
  for(String[] seed:cases){Case c=new Case(seed[0],seed[1]);c.setCaseId(seed[0]);sandbox.getCaseStorage().write(c);}
  CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);
  return new SessionWrapper(platform,sandbox);
 }
 /** Satisfy what the entry chosen last needs, a case with `caseId` for each selection, until it needs nothing;
  * false where it needs a search or a claim sent to HQ, which no test here answers (a menu whose forms read the
  * search, whose entries the search family's classes run). */
 static boolean fill(SessionWrapper session,String caseId,String label){
  for(int step=0;;step++){
   assertTrue(label+" needs more than ten values",step<10);
   EvaluationContext context=session.getEvaluationContext();
   String needed=session.getNeededData(context);
   if(needed==null)return true;
   if(needed.equals(SessionFrame.STATE_QUERY_REQUEST)||needed.equals(SessionFrame.STATE_SYNC_REQUEST))return false;
   if(needed.equals(SessionFrame.STATE_DATUM_VAL))session.setEntityDatum(session.getNeededDatum().getDataId(),caseId);
   else if(needed.equals(SessionFrame.STATE_MULTIPLE_DATUM_VAL))session.setDatum(SessionFrame.STATE_MULTIPLE_DATUM_VAL,session.getNeededDatum().getDataId(),"selection-"+caseId);
   else if(needed.equals(SessionFrame.STATE_DATUM_COMPUTED))session.setComputedDatum(context);
   else fail(label+" needs "+needed);
  }
 }
 @Test public void eachScreenListsWhatNovaSaysAndAsksForACaseFirstWhereNovaSays()throws Exception{
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   Suite suite=suite(document,hq);
   JSONArray screens=json("/menu-screens/"+document+".screens.json").getJSONArray("screens");
   for(int i=0;i<screens.length();i++){
    JSONObject screen=screens.getJSONObject(i);String menuId=screen.getString("menuId");String label=document+" "+menuId+" hq="+hq;
    SessionWrapper session=session(suite,MockDataUtils.getStaticStorage());
    List<String> expected=new ArrayList<>();JSONArray entries=screen.getJSONArray("entries");
    for(int j=0;j<entries.length();j++){JSONObject entry=entries.getJSONObject(j);if(entry.getBoolean("listed"))expected.add(entry.getString("command"));}
    MenuLoader loader=new MenuLoader(session.getPlatform(),session,menuId,FAIL,false,false);
    assertNull(label,loader.getLoadException());
    List<String> listed=new ArrayList<>();for(MenuDisplayable displayable:loader.getMenus())listed.add(displayable.getCommandID());
    assertEquals(label,expected,listed);
    if(menuId.equals("root"))continue;
    session.setCommand(menuId);
    String needed=session.getNeededData(session.getEvaluationContext());
    assertEquals(label,screen.getBoolean("asksCaseFirst"),SessionFrame.STATE_DATUM_VAL.equals(needed)||SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed));
   }
  }
 }
 @Test public void eachFormLandsWhereItsAfterSubmitSays()throws Exception{
  int landed=0;
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   Suite suite=suite(document,hq);
   JSONArray screens=json("/menu-screens/"+document+".screens.json").getJSONArray("screens");
   for(int i=0;i<screens.length();i++){
    JSONArray entries=screens.getJSONObject(i).getJSONArray("entries");
    for(int j=0;j<entries.length();j++){
     JSONObject entry=entries.getJSONObject(j);
     if(!entry.getString("kind").equals("form")||!entry.has("landsOn"))continue;
     String command=entry.getString("command");String label=document+" "+command+" hq="+hq;
     SessionWrapper session=session(suite,MockDataUtils.getStaticStorage());
     session.setCommand(command);
     if(!fill(session,"case-one",label))continue;
     landed++;
     // The answer says whether a frame is left to run, which Home and the first menu need not leave.
     session.finishExecuteAndPop(session.getEvaluationContext());
     String expected=entry.isNull("landsOn")?null:entry.getString("landsOn");
     assertEquals(label,expected,session.getCommand());
    }
   }
  }
  // Every form of the six documents but those of the one menu whose forms read the search lands, on both paths.
  assertTrue("forms landed: "+landed,landed>40);
 }
 /** Two top-level menus show their follow-up forms on the first menu, of case types alpha and beta, so every
  * form there opens one chosen case; an ordinary alpha menu's form links to the alpha form above. The link's
  * frame holds the alpha case ahead of the form's command, and once the worker steps back from that form, Core
  * keeps the case: choosing the ordinary beta menu asks for a form and never for a beta case, and the beta form
  * opens on the alpha case. Nova's gate refuses the link (`FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`). */
 @Test public void aFrameThroughAFirstMenuThatSharesOneCaseLeavesItsCaseForTheNextForm()throws Exception{
  for(boolean hq:new boolean[]{false,true}){
   String label="step-back-control hq="+hq;
   SessionWrapper session=session(suite("step-back-control",hq),MockDataUtils.getStaticStorage(),new String[]{"alpha-case","alpha"},new String[]{"beta-case","beta"});
   session.setCommand("m2");assertTrue(label,fill(session,"alpha-case",label));
   assertEquals(label,"m2-f0",session.getCommand());
   assertTrue(label,session.finishExecuteAndPop(session.getEvaluationContext()));
   assertEquals(label,"m0-f0",session.getCommand());
   assertEquals(label,"alpha-case",session.getData().get("case_id"));
   session.stepBack(session.getEvaluationContext());
   session.setCommand("m3");
   assertEquals(label,SessionFrame.STATE_COMMAND_ID,session.getNeededData(session.getEvaluationContext()));
   session.setCommand("m3-f0");
   assertNull(label,session.getNeededData(session.getEvaluationContext()));
   assertEquals(label,"alpha-case",session.getData().get("case_id"));
  }
 }
}
