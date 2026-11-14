package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.modern.util.Pair;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.LoggerInterface;
import org.commcare.util.mocks.*;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.Constants;
import org.javarosa.core.model.User;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Core's own menu listing, its case-first question and its after-submit frames over the menus Nova writes for
 * menus that show their forms in the menu above, on Nova's local suite and on HQ's build alike: each screen lists
 * what Preview shows there (`menuProjection.ts::previewScreenEntryVisibility` over `menuScreens.ts::menuScreenEntries`,
 * written by the producer), in order, for a worker holding each role a display condition compares and no case, so
 * every condition is read holding and not, a submenu's rows carrying its parent's (a row its own condition admits
 * and its parent's refuses is left off, which the producer names in `parentHides`); choosing a menu asks for a case
 * first exactly where Nova says the screen chooses a case first; each form with no destinations of its own lands
 * where Preview lands it (`frameLanding.ts::screenOfFrame` over its after-submit frame), every one of them: an entry
 * of a menu whose forms read the search is given the search's results and its claim as Core's own command-line
 * session gives them, and any other entry that asks for a search or a claim fails. The step-back control is the
 * fact Nova's refusal of a frame through a first menu that shares one case rests on. Core's in-memory case storage
 * stands in for a device's; no form is entered and no search or claim reaches a server. */
public class MenuScreensRuntimeTest {
 private static final String[] DOCUMENTS={"forms-in-menu-above","forms-in-menu-above-nested","forms-in-menu-above-registration-only","forms-in-menu-above-one-case","register-from-case-list","register-from-case-list-web-apps","register-from-case-list-other-returns","register-from-case-list-web-apps-other-returns"};
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
 static SessionWrapper session(Suite suite,MockUserDataSandbox sandbox,String[]... cases){return session(suite,sandbox,null,cases);}
 /** The same, the worker's `role` among its data where `role` is not null. */
 static SessionWrapper session(Suite suite,MockUserDataSandbox sandbox,String role,String[]... cases){
  User worker=new User("worker","","worker-id");if(role!=null)worker.setProperty("role",role);
  sandbox.setLoggedInUser(worker);
  for(String[] seed:cases){Case c=new Case(seed[0],seed[1]);c.setCaseId(seed[0]);sandbox.getCaseStorage().write(c);}
  CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);
  return new SessionWrapper(platform,sandbox);
 }
 /** Satisfy what the entry chosen last needs, a case with `caseId` for each selection, until it needs nothing.
  * Where the entry's menu has its forms read the search (`readsSearch`), the search is answered with an empty
  * result set (`RemoteQuerySessionManager.buildExternalDataInstance`, `CommCareSession.setQueryDatum`) and the
  * claim as having posted (`EXTRA_POST_SUCCESS`, as Core's `SyncScreen` marks it); anywhere else a search or a
  * claim is no step the entry should need. */
 static void fill(SessionWrapper session,String caseId,String label,boolean readsSearch)throws Exception{
  for(int step=0;;step++){
   assertTrue(label+" needs more than ten values",step<10);
   EvaluationContext context=session.getEvaluationContext();
   String needed=session.getNeededData(context);
   if(needed==null)return;
   if(needed.equals(SessionFrame.STATE_QUERY_REQUEST)||needed.equals(SessionFrame.STATE_SYNC_REQUEST))
    assertTrue(label+" needs "+needed+" in a menu whose forms do not read the search",readsSearch);
   if(needed.equals(SessionFrame.STATE_QUERY_REQUEST)){
    RemoteQuerySessionManager manager=RemoteQuerySessionManager.buildQuerySessionManager(session,context,new ArrayList<>());
    assertNotNull(label,manager);
    Pair<ExternalDataInstance,String> results=manager.buildExternalDataInstance(new ByteArrayInputStream("<results/>".getBytes(StandardCharsets.UTF_8)),"menu-screens-proof",com.google.common.collect.ArrayListMultimap.create());
    assertNotNull(label+": "+results.second,results.first);
    session.setQueryDatum(results.first);
   }
   else if(needed.equals(SessionFrame.STATE_SYNC_REQUEST))session.addExtraToCurrentFrameStep(Constants.EXTRA_POST_SUCCESS,true);
   else if(needed.equals(SessionFrame.STATE_DATUM_VAL))session.setEntityDatum(session.getNeededDatum().getDataId(),caseId);
   else if(needed.equals(SessionFrame.STATE_MULTIPLE_DATUM_VAL))session.setDatum(SessionFrame.STATE_MULTIPLE_DATUM_VAL,session.getNeededDatum().getDataId(),"selection-"+caseId);
   else if(needed.equals(SessionFrame.STATE_DATUM_COMPUTED))session.setComputedDatum(context);
   else fail(label+" needs "+needed);
  }
 }
 @Test public void eachScreenListsWhatNovaSaysAndAsksForACaseFirstWhereNovaSays()throws Exception{
  int parentHidden=0;
  for(String document:DOCUMENTS)for(boolean hq:new boolean[]{false,true}){
   Suite suite=suite(document,hq);
   JSONArray screens=json("/menu-screens/"+document+".screens.json").getJSONArray("screens");
   for(int i=0;i<screens.length();i++){
    JSONObject screen=screens.getJSONObject(i);String menuId=screen.getString("menuId");
    JSONArray listings=screen.getJSONArray("listings");
    for(int l=0;l<listings.length();l++){
     JSONObject listing=listings.getJSONObject(l);String role=listing.isNull("role")?null:listing.getString("role");
     String label=document+" "+menuId+" role="+role+" hq="+hq;
     SessionWrapper session=session(suite,MockDataUtils.getStaticStorage(),role);
     List<String> expected=new ArrayList<>();JSONArray commands=listing.getJSONArray("commands");
     for(int j=0;j<commands.length();j++)expected.add(commands.getString(j));
     MenuLoader loader=new MenuLoader(session.getPlatform(),session,menuId,FAIL,false,false);
     assertNull(label,loader.getLoadException());
     List<String> listed=new ArrayList<>();for(MenuDisplayable displayable:loader.getMenus())listed.add(displayable.getCommandID());
     assertEquals(label,expected,listed);
     // A row of a submenu shown above that its own condition, where it has one, admits and its parent's refuses: the
     // menu's relevance carries the parent's condition (`menus.py::_generate_menu`), so Core leaves the row off.
     JSONArray parentHides=listing.getJSONArray("parentHides");
     for(int j=0;j<parentHides.length();j++){
      assertFalse(label+" lists "+parentHides.getString(j)+", which its parent's condition hides",listed.contains(parentHides.getString(j)));
      parentHidden++;
     }
    }
    if(menuId.equals("root"))continue;
    String label=document+" "+menuId+" hq="+hq;
    SessionWrapper session=session(suite,MockDataUtils.getStaticStorage());
    session.setCommand(menuId);
    String needed=session.getNeededData(session.getEvaluationContext());
    // A menu whose forms read the search asks for its search, whose result is the case chosen, before any form.
    assertEquals(label,screen.getBoolean("asksCaseFirst"),SessionFrame.STATE_DATUM_VAL.equals(needed)||SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed)||SessionFrame.STATE_QUERY_REQUEST.equals(needed));
   }
  }
  // Some listing, on both paths, holds a submenu's row its parent's condition alone hides.
  assertTrue("rows a parent's condition alone hides: "+parentHidden,parentHidden>=2);
 }
 @Test public void eachFormLandsWhereItsAfterSubmitSays()throws Exception{
  int landed=0,searched=0;
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
     fill(session,"case-one",label,entry.getBoolean("readsSearch"));
     landed++;if(entry.getBoolean("readsSearch"))searched++;
     // The answer says whether a frame is left to run, which Home and the first menu need not leave.
     session.finishExecuteAndPop(session.getEvaluationContext());
     String expected=entry.isNull("landsOn")?null:entry.getString("landsOn");
     assertEquals(label,expected,session.getCommand());
    }
   }
  }
  // Every form of every document lands, on both paths, those of the menus whose forms read the search among them.
  assertTrue("forms landed: "+landed,landed>40);
  assertTrue("forms of a menu whose forms read the search landed: "+searched,searched>0);
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
   session.setCommand("m2");fill(session,"alpha-case",label,false);
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
