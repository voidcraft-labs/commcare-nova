package nova.compatibility;

import org.javarosa.core.model.*;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Native parser metadata and form entry, using exact admitted Nova artifacts. */
public class ContainerRuntimeTest {
 private static TreeElement node(String name,String value) {
  TreeElement n = new TreeElement(name,0);
  if(value != null)n.setValue(new StringData(value));
  return n;
 }
 private static InstanceInitializationFactory environment() {
  return new InstanceInitializationFactory() {
   @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
    if("casedb".equals(instance.getInstanceId())) {
     // An empty case database: a form that names a case type declares it, and these forms read no case.
     TreeElement cases=node("casedb",null);
     InstanceUtils.setUpInstanceRoot(cases,instance.getInstanceId(),new InstanceBase(instance.getInstanceId()));
     return new ConcreteInstanceRoot(cases);
    }
    if(!"commcaresession".equals(instance.getInstanceId()))throw new AssertionError(instance.getInstanceId());
    TreeElement root=node("session",null), context=node("context",null), data=node("data",null);
    for(String key:new String[]{"deviceid","username","userid","appversion"})context.addChild(node(key,"fixture-"+key));
    context.addChild(node("drift","0"));data.addChild(node("case_id_new_patient_0","new-patient"));data.addChild(node("case_id_new_household_0","new-household"));
    root.addChild(context);root.addChild(data);
    InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),new InstanceBase(instance.getInstanceId()));
    return new ConcreteInstanceRoot(root);
   }
  };
 }
 private static Object eval(FormDef form,String expression)throws Exception{return ExprEvalUtils.xpathEval(form.getEvaluationContext(),expression);}
 private static void referenceCount(FormDef form,String id,double expected)throws Exception{
  for(String spelling:new String[]{"hashtag","path"})assertEquals(id+" "+spelling,expected,eval(form,"number(/data/"+id+"_"+spelling+"_count)"));
 }
 private static void referenceValues(FormDef form,String id,String expected)throws Exception{
  for(String spelling:new String[]{"hashtag","path"})assertEquals(id+" "+spelling,expected,eval(form,"string(/data/"+id+"_"+spelling+"_values)"));
 }
 private static FormParseInit load(String scenario,boolean source)throws Exception{
  FormParseInit parsed=new FormParseInit("/container/container-"+scenario+(source?".hq.xml":".xml"));
  parsed.getFormDef().initialize(true,environment());return parsed;
 }
 private static void enter(FormParseInit parsed,boolean user)throws Exception {
  FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
  int steps=0,event;boolean created=false;
  while((event=controller.stepToNextEvent())!=FormEntryController.EVENT_END_OF_FORM){
   if(++steps>200)throw new AssertionError("Entry did not terminate");
   if(event==FormEntryController.EVENT_PROMPT_NEW_REPEAT&&user&&!created){controller.newRepeat();created=true;}
  }
 }
 /** The first node `path` names, relevant or not: an evaluated nodeset leaves out every node that is not relevant
  * (`XPathLazyNodeset.performEvaluation`), and a row past the end of a query's result is one, while
  * `EvaluationContext.expandReference` keeps it. */
 private static org.javarosa.core.model.instance.TreeReference ref(FormDef form,String path)throws Exception {
  java.util.Vector<org.javarosa.core.model.instance.TreeReference> refs=held(form,path);
  assertFalse(path+" names no node",refs.isEmpty());
  return refs.elementAt(0);
 }
 /** Every node `path` names, relevant or not (`ref`). */
 private static java.util.Vector<org.javarosa.core.model.instance.TreeReference> held(FormDef form,String path)throws Exception {
  return form.getEvaluationContext().expandReference(((org.javarosa.xpath.expr.XPathPathExpr)org.javarosa.xpath.XPathParseTool.parseXPath(path)).getReference());
 }
 /** The value the instance holds at `path`, which an XPath read gives as blank where the node is not relevant
  * (`XPathPathExpr.getRefValue`). */
 private static String stored(FormDef form,String path)throws Exception {
  org.javarosa.core.model.data.IAnswerData value=form.getMainInstance().resolveReference(ref(form,path)).getValue();
  return value==null?"":value.uncast().getString();
 }
 private static void answer(FormDef form,String path,String value)throws Exception {form.setValue(new StringData(value),ref(form,path));}
 private static int confirm(FormParseInit parsed,String path,String value)throws Exception {
  FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());int event,steps=0;
  while((event=controller.stepToNextEvent())!=FormEntryController.EVENT_END_OF_FORM){
   if(++steps>200)throw new AssertionError("Confirmation question not reached");
   if(event==FormEntryController.EVENT_QUESTION && controller.getModel().getFormIndex().getReference().equals(ref(parsed.getFormDef(),path)))return controller.answerQuestion(new StringData(value));
  }
  throw new AssertionError("Missing confirmation question "+path);
 }
 @Test public void conditionalQueriesAndCandidateValidationUseTheActualSelectedRows()throws Exception {
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"query-conditional","query-conditional-parent","query-conditional-relative"}){
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();String parent=scenario.endsWith("parent")?"/data/page":"/data",items=parent+"/items/item",check=parent+"/confirm";
   enter(parsed,false);
   answer(form,"/data/show","yes");enter(parsed,false);
   assertEquals(2.0,eval(form,"count("+items+")"));assertEquals("a b",eval(form,"join(' ', "+items+"/item_id)"));
   assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,confirm(parsed,check,"yes"));
   answer(form,items+"[1]/choice","yes");
   assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,confirm(parsed,check,"no"));
   assertEquals(FormEntryController.ANSWER_OK,confirm(parsed,check,"yes"));
   answer(form,items+"[2]/choice","yes");
   assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,confirm(parsed,check,"yes"));
   answer(form,items+"[2]/choice","no");
   answer(form,"/data/show","no");enter(parsed,false);answer(form,"/data/show","yes");enter(parsed,false);
   assertEquals(2.0,eval(form,"count("+items+")"));assertEquals("yes",eval(form,"string("+items+"[1]/choice)"));
   assertEquals(FormEntryController.ANSWER_OK,confirm(parsed,check,"yes"));
   // A count of the answer being validated must still see its uncommitted
   // candidate, rather than a calculated value from the previous answer.
   assertEquals(FormEntryController.ANSWER_OK,confirm(parsed,"/data/self_check","yes"));
   assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,confirm(parsed,"/data/self_check","no"));
  }
 }
 @Test public void initializationActionsApplyRelevanceBeforeSnapshots()throws Exception {
  FormParseInit parsed=load("init-relevance",false);FormDef form=parsed.getFormDef();enter(parsed,false);
  assertEquals(0.0,eval(form,"count(/data/assets/item)"));
  parsed=load("init-relevance-add",false);form=parsed.getFormDef();enter(parsed,true);
  assertEquals(0.0,eval(form,"count(/data/visits[1]/assets/item)"));
  answer(form,"/data/enabled","yes");enter(parsed,true);
  assertEquals(0.0,eval(form,"count(/data/visits[1]/assets/item)"));
  assertEquals(2.0,eval(form,"count(/data/visits[2]/assets/item)"));
  assertEquals("",eval(form,"string(/data/visits[1]/derived)"));
  assertEquals("north",eval(form,"string(/data/visits[2]/derived)"));
 }
 @Test public void initializationSnapshotsRetainTheirEnclosingRow()throws Exception {
  for(String scenario:new String[]{"init-named","init-raw"}) {
   FormParseInit parsed=load(scenario,false);FormDef form=parsed.getFormDef();enter(parsed,false);
   assertEquals("pump tap",eval(form,"join(' ', /data/assets/item/row_id)"));
   assertEquals("pump_task",eval(form,"string(/data/assets/item[1]/tasks/item/task_id)"));
   assertEquals(0.0,eval(form,"count(/data/assets/item[2]/tasks/item)"));
   assertEquals(2.0,eval(form,"count(/data/assets/item[1]/details/checks)"));
   assertEquals(0.0,eval(form,"count(/data/assets/item[2]/details/checks)"));
  }
 }
 @Test public void addingAnOuterRowKeepsOldSnapshotsAndAnswers()throws Exception {
  FormParseInit parsed=load("init-add",false);FormDef form=parsed.getFormDef();enter(parsed,true);
  assertEquals("pump tap",eval(form,"join(' ', /data/visits[1]/assets/item/row_id)"));
  answer(form,"/data/visits[1]/assets/item[2]/note","Retain this answer");
  answer(form,"/data/zone","south");enter(parsed,true);
  assertEquals(2.0,eval(form,"count(/data/visits)"));
  assertEquals("pump tap",eval(form,"join(' ', /data/visits[1]/assets/item/row_id)"));
  assertEquals("Retain this answer",eval(form,"string(/data/visits[1]/assets/item[2]/note)"));
  assertEquals("tank",eval(form,"string(/data/visits[2]/assets/item/row_id)"));
 }
 /** A default reads relatively from the node it sets (current()/...), so each of its four placements reads the
  * answer its path names: at the root, in a repeat row reading an answer outside the repeat, in a row reading a
  * sibling in the row, and in a nested repeat's row reading the enclosing row's answer. */
 @Test public void defaultsReadTheAnswerTheirPlacementNames()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("init-add",source);FormDef form=parsed.getFormDef();
   assertEquals("north",eval(form,"string(/data/root_read)"));
   enter(parsed,true);
   assertEquals(1.0,eval(form,"count(/data/visits)"));
   assertEquals("north",eval(form,"string(/data/visits[1]/zone)"));
   assertEquals("north",eval(form,"string(/data/visits[1]/sibling_read)"));
   assertEquals("north north",eval(form,"join(' ', /data/visits[1]/assets/item/enclosing_read)"));
   answer(form,"/data/zone","south");enter(parsed,true);
   assertEquals(2.0,eval(form,"count(/data/visits)"));
   assertEquals("north",eval(form,"string(/data/root_read)"));
   assertEquals("north",eval(form,"string(/data/visits[1]/zone)"));
   assertEquals("north",eval(form,"string(/data/visits[1]/sibling_read)"));
   assertEquals("north north",eval(form,"join(' ', /data/visits[1]/assets/item/enclosing_read)"));
   assertEquals("south",eval(form,"string(/data/visits[2]/zone)"));
   assertEquals("south",eval(form,"string(/data/visits[2]/sibling_read)"));
   assertEquals(1.0,eval(form,"count(/data/visits[2]/assets/item)"));
   assertEquals("south",eval(form,"string(/data/visits[2]/assets/item/enclosing_read)"));
  }
 }
 /** A registration form reads its own new case's id from the session's datum, which is also the id its create
  * block carries: a default and a calculation of it hold the id the session gives case_id_new_patient_0. */
 @Test public void registrationFormReadsItsOwnNewCaseId()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("registration",source);FormDef form=parsed.getFormDef();enter(parsed,false);
   assertEquals("new-patient",eval(form,"string(/data/case/@case_id)"));
   assertEquals("new-patient",eval(form,"string(/data/page/own_id_read)"));
   assertEquals("P-new-patient",eval(form,"string(/data/page/tracking_code)"));
  }
 }
 @Test public void groupMetadataAndDescendantsSurviveNativeParsing()throws Exception{
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"titled","untitled","empty","transparent","labelled","nested","registration"}){
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();
   GroupDef page=(GroupDef)form.getChildren().get(0);
   assertEquals(scenario,!"transparent".equals(scenario)?"field-list":null,page.getAppearanceAttr());
   assertEquals(scenario,!("untitled".equals(scenario)||"empty".equals(scenario)||"transparent".equals(scenario)),page.getTextID()!=null);
   assertFalse(page.isRepeat());
   if("nested".equals(scenario)){
    assertEquals("field-list",((GroupDef)page.getChildren().get(0)).getAppearanceAttr());
    assertNull(((GroupDef)page.getChildren().get(1)).getAppearanceAttr());
    assertEquals(1.0,eval(form,"count(/data/page/named/answer)"));
    assertEquals(1.0,eval(form,"count(/data/page/plain/answer)"));
   } else assertEquals(1.0,eval(form,"count(/data/page/answer)"));
   if("empty".equals(scenario)){
    GroupDef empty=(GroupDef)form.getChildren().get(1);
    assertEquals("field-list",empty.getAppearanceAttr());assertEquals(0,empty.getChildren().size());
   }
   enter(parsed,false);
  }
 }
 @Test public void actualEntryCreatesIndependentCountsAndQueryIdentities()throws Exception{
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"user","path","literal","expression","cousins","query","nested-query","path-late","nested-count","count-collision"}){
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();enter(parsed,"user".equals(scenario));
   switch(scenario){
    case "user":assertEquals(1.0,eval(form,"count(/data/items)"));break;
    case "path-late":
    case "path":assertEquals(2.0,eval(form,"count(/data/items)"));break;
    case "literal":
     assertEquals(3.0,eval(form,"count(/data/items)"));
     referenceCount(form,"items",3.0);break;
    case "count-collision":assertEquals(3.0,eval(form,"count(/data/items)"));assertEquals("authored",eval(form,"string(/data/nova_count_items)"));break;
    case "expression":assertEquals(4.0,eval(form,"count(/data/items)"));break;
    case "cousins":assertEquals(3.0,eval(form,"count(/data/one/items)"));assertEquals(5.0,eval(form,"count(/data/two/items)"));break;
    case "query":
     assertEquals(3.0,eval(form,"count(/data/items/item)"));assertEquals("a b c",eval(form,"join(' ', /data/items/item/item_id)"));
     referenceCount(form,"items",3.0);referenceCount(form,"empty_items",0.0);
     referenceValues(form,"ids","a b c");referenceValues(form,"authored_items","authored authored authored");break;
    case "nested-count":
     assertEquals(2.0,eval(form,"count(/data/parents/item[1]/items)"));
     assertEquals(3.0,eval(form,"count(/data/parents/item[2]/items)"));break;
    case "nested-query":
     assertEquals(2.0,eval(form,"count(/data/items/item)"));
     assertEquals(2.0,eval(form,"count(/data/items/item[1]/children/item)"));
     assertEquals(1.0,eval(form,"count(/data/items/item[2]/children/item)"));
     assertEquals("a1 a2",eval(form,"join(' ', /data/items/item[1]/children/item/item_id)"));
     assertEquals("b1",eval(form,"join(' ', /data/items/item[2]/children/item/item_id)"));
     referenceCount(form,"items",2.0);referenceCount(form,"children",3.0);
     referenceValues(form,"child_ids","a1 a2 b1");break;
   }
  }
 }

 @Test public void liveCountsGrowButKeepCreatedRowsAndAnswers()throws Exception {
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"path","expression","hidden-count"}) {
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();enter(parsed,false);
   answer(form,"/data/items[1]/answer","retained");
   form.setValue(new org.javarosa.core.model.data.IntegerData(5),ref(form,"/data/size"));enter(parsed,false);
   double count="path".equals(scenario)?5.0:7.0;
   assertEquals(count,eval(form,"count(/data/items)"));
   form.setValue(new org.javarosa.core.model.data.IntegerData(1),ref(form,"/data/size"));enter(parsed,false);
   assertEquals(count,eval(form,"count(/data/items)"));assertEquals("retained",eval(form,"string(/data/items[1]/answer)"));
  }
 }

 @Test public void earlierPageAnswerCreatesLiveRowsWithIndependentNestedCounts()throws Exception {
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"live-count-entry","live-count-effects"}) {
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();
   FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
   assertEquals(FormEntryController.EVENT_GROUP,controller.stepToNextEvent());
   var prompts=controller.getQuestionPrompts();assertEquals(1,prompts.length);
   assertEquals(0.0,eval(form,"count(/data/second/items)"));
   assertEquals(FormEntryController.ANSWER_OK,controller.answerQuestion(prompts[0].getIndex(),new org.javarosa.core.model.data.IntegerData(2)));
   controller.jumpToIndex(prompts[0].getIndex());assertEquals(FormEntryController.EVENT_GROUP,controller.stepToNextEvent());controller.getQuestionPrompts();
   assertEquals(2.0,eval(form,"count(/data/second/items)"));
   for(int i=1;i<=2;i++) form.setValue(new org.javarosa.core.model.data.IntegerData(i+1),ref(form,"/data/second/items["+i+"]/size"));
   enter(parsed,false);
   for(String child:new String[]{"direct","computed"}) {
    assertEquals(2.0,eval(form,"count(/data/second/items[1]/"+child+")"));
    assertEquals(3.0,eval(form,"count(/data/second/items[2]/"+child+")"));
   }
   answer(form,"/data/second/items[2]/answer","retained after decrease");
   form.setValue(new org.javarosa.core.model.data.IntegerData(4),ref(form,"/data/first/size"));enter(parsed,false);
   form.setValue(new org.javarosa.core.model.data.IntegerData(1),ref(form,"/data/first/size"));enter(parsed,false);
   assertEquals(4.0,eval(form,"count(/data/second/items)"));
   String xml=new String(new org.javarosa.model.xform.XFormSerializingVisitor().serializeInstance(form.getMainInstance()),java.nio.charset.StandardCharsets.UTF_8);
   assertTrue(xml.contains("retained after decrease"));
   javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
   org.w3c.dom.Document submitted=factory.newDocumentBuilder().parse(new java.io.ByteArrayInputStream(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
   assertEquals(scenario.equals("live-count-effects")?4:0,submitted.getElementsByTagNameNS("http://commcarehq.org/case/transaction/v2","create").getLength());
  }
 }

 @Test public void fieldListPromptCollectionFlattensNestedGroupsAndCannotOfferNewRepeat()throws Exception {
  for(boolean source:new boolean[]{false,true}) {
   FormParseInit parsed=load("nested",source);
   FormEntryController controller=parsed.getFormEntryController();
   controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
   assertEquals(FormEntryController.EVENT_GROUP,controller.stepToNextEvent());
   assertTrue(controller.isFieldListHost(controller.getModel().getFormIndex()));
   assertEquals(2,controller.getQuestionPrompts().length);
   // Deliberately invalid Nova layout isolates the native prompt collector:
   // field-list collection exposes questions, with no way to create the first row.
   FormParseInit invalid=load("user",source);
   GroupDef host=new GroupDef();host.setBind(new org.javarosa.model.xform.XPathReference("/data"));host.setAppearanceAttr("field-list");
   host.addChild(invalid.getFormDef().getChildren().get(0));
   java.util.Vector<IFormElement> children=new java.util.Vector<>();children.add(host);invalid.getFormDef().setChildren(children);
   FormEntryController invalidController=new FormParseInit(invalid.getFormDef()).getFormEntryController();
   invalidController.jumpToIndex(FormIndex.createBeginningOfFormIndex());
   assertEquals(FormEntryController.EVENT_GROUP,invalidController.stepToNextEvent());
   assertEquals(0,invalidController.getQuestionPrompts().length);
   assertEquals(0.0,eval(invalid.getFormDef(),"count(/data/items)"));
  }
 }

 /** Deliberate wire probes isolate native typing; decimal/text direct counts
  * are refused by Nova's admission rule, so these are not admitted apps. */
 @Test public void nativeCountTypesAndCalculatedNarrowing()throws Exception {
  String[][] cases={{"int","","0.0"},{"int","2","2.0"},{"decimal","","0.0"},{"decimal","2","invalid"},{"decimal","2.7","invalid"},{"string","","0.0"},{"string","2","2.0"},{"string","2.0","invalid"},{"string"," 2 ","invalid"}};
  for(String[] item:cases) {
   javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
   org.w3c.dom.Document document;
   try(java.io.InputStream stream=getClass().getResourceAsStream("/container/container-path.xml")){document=factory.newDocumentBuilder().parse(stream);}
   org.w3c.dom.NodeList nodes=document.getElementsByTagName("*");
   for(int n=0;n<nodes.getLength();n++) {
    org.w3c.dom.Element element=(org.w3c.dom.Element)nodes.item(n);
    if("bind".equals(element.getLocalName())&&"/data/size".equals(element.getAttribute("nodeset")))element.setAttribute("type","xsd:"+item[0]);
    if("setvalue".equals(element.getLocalName())&&"/data/size".equals(element.getAttribute("ref")))element.setAttribute("value","'"+item[1]+"'");
   }
   java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
   javax.xml.transform.TransformerFactory.newInstance().newTransformer().transform(new javax.xml.transform.dom.DOMSource(document),new javax.xml.transform.stream.StreamResult(bytes));
   String actual;
   try(java.io.InputStream input=new java.io.ByteArrayInputStream(bytes.toByteArray())) {
    FormDef form=org.javarosa.xform.util.XFormUtils.getFormFromInputStream(input);form.initialize(true,environment());
    enter(new FormParseInit(form),false);actual=eval(form,"count(/data/items)").toString();
   }catch(org.javarosa.xpath.XPathTypeMismatchException error){actual="invalid";}
   assertEquals(item[0]+" lexical="+item[1],item[2],actual);
  }
 }

 /** Deliberately invalid Nova count: Core parses it but every new row raises
  * the target again. Admission must reject this cardinality feedback. */
 @Test public void countFeedbackKeepsCreatingRowsDuringEntry()throws Exception {
  javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
  org.w3c.dom.Document document;
  try(java.io.InputStream stream=getClass().getResourceAsStream("/container/container-literal.xml")){document=factory.newDocumentBuilder().parse(stream);}
  org.w3c.dom.NodeList nodes=document.getElementsByTagName("*");boolean changed=false;
  for(int n=0;n<nodes.getLength();n++) {
   org.w3c.dom.Element element=(org.w3c.dom.Element)nodes.item(n);
   if("bind".equals(element.getLocalName())&&"/data/nova_count_items".equals(element.getAttribute("nodeset"))) {
    element.setAttribute("calculate","count(/data/items) + 1");changed=true;
   }
  }
  assertTrue(changed);
  java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
  javax.xml.transform.TransformerFactory.newInstance().newTransformer().transform(new javax.xml.transform.dom.DOMSource(document),new javax.xml.transform.stream.StreamResult(bytes));
  try(java.io.InputStream input=new java.io.ByteArrayInputStream(bytes.toByteArray())) {
   FormDef form=org.javarosa.xform.util.XFormUtils.getFormFromInputStream(input);form.initialize(true,environment());
   FormEntryController controller=new FormParseInit(form).getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
   for(int step=0;step<12;step++) assertNotEquals(FormEntryController.EVENT_END_OF_FORM,controller.stepToNextEvent());
   assertEquals(6.0,eval(form,"count(/data/items)"));
   assertEquals(7.0,eval(form,"number(/data/nova_count_items)"));
  }
 }

 @Test public void laterAuthoredDefaultsExistBeforeCountEntry()throws Exception {
  FormParseInit parsed=load("path-late",false);enter(parsed,false);
  assertEquals(2.0,eval(parsed.getFormDef(),"count(/data/items)"));
 }
 @Test public void countCalculationsUseEachEnclosingRepeatRow()throws Exception {
  FormParseInit parsed=load("nested-count",false);enter(parsed,false);
  assertEquals(2.0,eval(parsed.getFormDef(),"count(/data/parents/item[1]/items)"));
  assertEquals(3.0,eval(parsed.getFormDef(),"count(/data/parents/item[2]/items)"));
 }


 @Test public void laterFieldListInsertsRowsAfterEarlierAnswers()throws Exception {
  FormParseInit parsed=load("section-entry",false);FormDef form=parsed.getFormDef();
  FormEntryController controller=parsed.getFormEntryController();
  controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
  assertEquals(FormEntryController.EVENT_GROUP,controller.stepToNextEvent());
  org.javarosa.form.api.FormEntryPrompt[] first=controller.getQuestionPrompts();
  assertEquals(1,first.length);
  assertEquals(0.0,eval(form,"count(/data/second/rounds)"));
  assertEquals(FormEntryController.ANSWER_OK,controller.answerQuestion(first[0].getIndex(),new StringData("south")));
  controller.jumpToIndex(first[0].getIndex());
  assertEquals(FormEntryController.EVENT_GROUP,controller.stepToNextEvent());
  FormIndex secondPage=controller.getModel().getFormIndex();
  org.javarosa.form.api.FormEntryPrompt[] second=controller.getQuestionPrompts();
  assertEquals(1,second.length);assertEquals("tank",second[0].getAnswerText());
  assertEquals(FormEntryController.ANSWER_OK,controller.answerQuestion(second[0].getIndex(),new StringData("retained")));
  assertEquals(FormEntryController.ANSWER_OK,controller.answerQuestion(first[0].getIndex(),new StringData("north")));
  controller.jumpToIndex(secondPage);
  // The nested query reads the area, so its rows follow it (part 04 §1.5): the north area's two assets have their
  // rows, the first keeps its answer at its place, and the new row's default reads its own id, set when the row is
  // made, before any calculate runs (`FormDef.createNewRepeat`). Preview's journey and browser tests hold the same.
  second=controller.getQuestionPrompts();
  assertEquals(2,second.length);
  assertEquals("retained",second[0].getAnswerText());assertEquals("tap",second[1].getAnswerText());
 }
 /** `container-hidden-count`'s `jr:count` names the Hidden Value `desired` directly, since its calculate is an
  * integer (part 04 §2.4), so Core reads the Hidden Value's own data: an integral result is `IntegerData` whatever
  * the bind's type (`Recalculate.wrapData`), and a fraction is `DecimalData`, which `IntegerData.cast` refuses.
  * Each calculate is swapped in by hand; the fractional one is what Nova's validator refuses as a count
  * (`REPEAT_COUNT_TYPE`), and a fraction is counted only through a carrier (`RepeatCountRuntimeTest`'s control). */
 @Test public void hiddenCalculationCountTypes()throws Exception {
  String[][] cases={{"2.7","invalid"},{"true()","1.0"},{"false()","0.0"},{"'2.7'","invalid"},{"'2'","2.0"},{"''","0.0"},{"number('')","0.0"}};
  for(String[] item:cases) {
   String calculate=item[0];
   javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
   org.w3c.dom.Document document;
   try(java.io.InputStream stream=getClass().getResourceAsStream("/container/container-hidden-count.xml")){document=factory.newDocumentBuilder().parse(stream);}
   org.w3c.dom.NodeList nodes=document.getElementsByTagName("*");
   for(int n=0;n<nodes.getLength();n++) {
    org.w3c.dom.Element element=(org.w3c.dom.Element)nodes.item(n);
    if("bind".equals(element.getLocalName())&&"/data/desired".equals(element.getAttribute("nodeset")))element.setAttribute("calculate",calculate);
   }
   java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
   javax.xml.transform.TransformerFactory.newInstance().newTransformer().transform(new javax.xml.transform.dom.DOMSource(document),new javax.xml.transform.stream.StreamResult(bytes));
   try(java.io.InputStream input=new java.io.ByteArrayInputStream(bytes.toByteArray())) {
    FormDef form=org.javarosa.xform.util.XFormUtils.getFormFromInputStream(input);form.initialize(true,environment());
    String actual;
    try {enter(new FormParseInit(form),false);actual=eval(form,"count(/data/items)").toString();}
    catch(org.javarosa.xpath.XPathTypeMismatchException error){actual="invalid";}
    assertEquals(calculate,item[1],actual);
   }
  }
 }

 // Part 04's gated run G2: Core's reading of a query repeat in each placement. A query repeat whose rows can
 // follow an answer is written in the count placement (part 04 §1.5): `nova_query_ids_<r>` and
 // `nova_query_count_<r>` in the wrapper, each row's 0-based place `nova_query_index_<r>` set from `position(..)`
 // when the row is made, its id set then too and calculated as
 // `if(../nova_query_index_<r> < ../../nova_query_count_<r>, selected-at(../../nova_query_ids_<r>, ../nova_query_index_<r>), '')`,
 // and the row relevant only while `position() < ../nova_query_count_<r>`. One that cannot is written in model
 // iteration, HQ's form builder's own spelling (part 04 §1.4).

 /** Each row of `generic` the entry steps onto, keyed by its repeat multiplicities, with `expression` read at the
  * row the moment the controller first reaches it: right after `FormDef.createNewRepeat` made it, before any
  * other answer changes. */
 private static java.util.Map<String,String> enterReading(FormParseInit parsed,String generic,String expression)throws Exception {
  java.util.Map<String,String> read=new java.util.LinkedHashMap<>();
  FormDef form=parsed.getFormDef();
  FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
  int steps=0,event;
  while((event=controller.stepToNextEvent())!=FormEntryController.EVENT_END_OF_FORM){
   if(++steps>400)throw new AssertionError("Entry did not terminate");
   if(event!=FormEntryController.EVENT_REPEAT)continue;
   org.javarosa.core.model.instance.TreeReference row=controller.getModel().getFormIndex().getReference();
   if(!generic.equals(row.genericize().toString(false)))continue;
   StringBuilder key=new StringBuilder();
   for(int level=0;level<row.size();level++)if("item".equals(row.getName(level)))key.append(key.length()==0?"":"/").append(row.getMultiplicity(level));
   read.putIfAbsent(key.toString(),String.valueOf(ExprEvalUtils.xpathEval(new org.javarosa.core.model.condition.EvaluationContext(form.getEvaluationContext(),row),expression)));
  }
  return read;
 }
 private static boolean relevant(FormDef form,String path)throws Exception {return form.getMainInstance().resolveReference(ref(form,path)).isRelevant();}
 /** The instance a submission carries (`XFormSerializingVisitor` leaves out every node that is not relevant). */
 private static String submission(FormDef form)throws Exception {
  return new String(new org.javarosa.model.xform.XFormSerializingVisitor().serializeInstance(form.getMainInstance()),java.nio.charset.StandardCharsets.UTF_8);
 }
 private static int caseCreates(String xml)throws Exception {
  javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
  org.w3c.dom.Document submitted=factory.newDocumentBuilder().parse(new java.io.ByteArrayInputStream(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
  return submitted.getElementsByTagNameNS("http://commcarehq.org/case/transaction/v2","create").getLength();
 }

 /** Model iteration in the form builder's spelling: the `xforms-ready` setvalues fill `@ids` and `@count` as the
  * form loads, before any entry, and each row's `jr-insert` setvalues give it `@index` from `@current_index`
  * before the bind recomputes it (`FormDef.createNewRepeat` fires `jr-insert` before calculates), then `@id`.
  * Catches a spelling Core does not initialize at load (rows never made) or an index read after the recompute
  * (every id shifted by one). */
 @Test public void modelIterationInTheFormBuildersSpellingInitializesAtLoad()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("query",source);FormDef form=parsed.getFormDef();
   assertEquals("a b c",eval(form,"string(/data/items/@ids)"));
   assertEquals(3.0,eval(form,"number(/data/items/@count)"));
   assertEquals(0.0,eval(form,"number(/data/empty_items/@count)"));
   assertEquals(0.0,eval(form,"count(/data/items/item)"));
   java.util.Map<String,String> ids=enterReading(parsed,"/data/items/item","string(@id)");
   assertEquals(java.util.Map.of("0","a","1","b","2","c"),ids);
   for(int row=1;row<=3;row++)assertEquals("row "+row,(double)(row-1),eval(form,"number(/data/items/item["+row+"]/@index)"));
   assertEquals(3.0,eval(form,"number(/data/items/@current_index)"));
   assertEquals("a b c",eval(form,"join(' ', /data/items/item/item_id)"));
   assertEquals(0.0,eval(form,"count(/data/empty_items/item)"));
  }
 }

 /** `container-query-follows`: the `members` query reads the form's `order` answer, and each row creates a member
  * case. Rows are made up to the count, and each new row's 0-based place is stored as it is made, so the row's id,
  * index and the rows made so far hold at once. Then, with an answer at each place:
  * a shrink of the result hides the rows past its end and leaves them, their answers and their case blocks out of
  * the submission without removing them; growth back shows them again with their answers; and a reorder moves the
  * ids by position while each answer stays at its position (part 04 §1.5, the notice `repeat-rows-follow-query`).
  * Catches a row id read against the template before the row exists (G2's outcome B1), a guard that hides
  * nothing or submits hidden rows (B2), ids that keep the record a row was made for (C), and a row id that cannot
  * be calculated once its row is hidden (`position(..)` there names no node and throws). */
 @Test public void queryRowsFollowTheResultAndAnswersKeepTheirPosition()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("query-follows",source);FormDef form=parsed.getFormDef();
   String rows="/data/members/item";
   assertEquals("full",eval(form,"string(/data/order)"));
   assertEquals(java.util.Map.of("0","a","1","b","2","c"),enterReading(parsed,rows,"string(nova_query_id_members)"));
   parsed=load("query-follows",source);form=parsed.getFormDef();
   assertEquals(java.util.Map.of("0","0","1","1","2","2"),enterReading(parsed,rows,"string(ordinal)"));
   parsed=load("query-follows",source);form=parsed.getFormDef();
   assertEquals(java.util.Map.of("0","1","1","2","2","3"),enterReading(parsed,rows,"string(made)"));
   assertEquals(3.0,eval(form,"count("+rows+")"));
   assertEquals("a b c",eval(form,"join(' ', "+rows+"/record)"));
   // Each row keeps the rows made as of its own making: a new row recounts the position node, and Core narrows the
   // calculates that read it to the row that changed (`FormDef.evaluateTriggerable`, `Triggerable.narrowContextBy`),
   // as it does for model iteration's `@current_index`.
   assertEquals("1 2 3",eval(form,"join(' ', "+rows+"/made)"));
   answer(form,"/data/case_name","Home");
   String[] places={"first","second","third"},names={"Ama","Kofi","Esi"};
   for(int row=1;row<=3;row++){answer(form,rows+"["+row+"]/note",places[row-1]);answer(form,rows+"["+row+"]/case_name",names[row-1]);}
   String xml=submission(form);
   assertEquals(4,caseCreates(xml));
   for(String place:places)assertTrue(place,xml.contains(place));

   answer(form,"/data/order","short");enter(parsed,false);
   // Lowering the count removes no row; an XPath count reads only the relevant ones.
   assertEquals("lowering the count removes no row",3,held(form,rows).size());
   assertEquals(1.0,eval(form,"count("+rows+")"));
   assertTrue(relevant(form,rows+"[1]"));assertFalse(relevant(form,rows+"[2]"));assertFalse(relevant(form,rows+"[3]"));
   assertEquals("a",eval(form,"string("+rows+"[1]/record)"));
   assertEquals("",eval(form,"string("+rows+"[2]/nova_query_id_members)"));
   assertEquals("an answer past the end stays in the form","third",stored(form,rows+"[3]/note"));
   assertEquals("and reads blank while its row is hidden","",eval(form,"string("+rows+"[3]/note)"));
   xml=submission(form);
   assertEquals("the household and the one member still in the result",2,caseCreates(xml));
   assertTrue(xml.contains("first"));assertFalse(xml.contains("second"));assertFalse(xml.contains("third"));
   assertFalse(xml.contains("Kofi"));assertFalse(xml.contains("Esi"));

   answer(form,"/data/order","full");enter(parsed,false);
   assertEquals(3.0,eval(form,"count("+rows+")"));
   for(int row=1;row<=3;row++)assertTrue("row "+row,relevant(form,rows+"["+row+"]"));
   assertEquals("a b c",eval(form,"join(' ', "+rows+"/record)"));
   assertEquals("first second third",eval(form,"join(' ', "+rows+"/note)"));
   xml=submission(form);
   assertEquals(4,caseCreates(xml));
   for(String place:places)assertTrue(place,xml.contains(place));

   answer(form,"/data/order","reverse");enter(parsed,false);
   assertEquals("c b a",eval(form,"join(' ', "+rows+"/nova_query_id_members)"));
   assertEquals("c b a",eval(form,"join(' ', "+rows+"/record)"));
   assertEquals("first second third",eval(form,"join(' ', "+rows+"/note)"));
   assertEquals("Ama Kofi Esi",eval(form,"join(' ', "+rows+"/case_name)"));
   assertEquals("0 1 2",eval(form,"join(' ', "+rows+"/ordinal)"));
   assertEquals(4,caseCreates(submission(form)));
  }
 }

 /** `container-query-hidden-row`: two repeats over `a b c` whose condition `position() != 1` hides the second row.
  * `held` holds model iteration: a new row takes `@index` from `int(@current_index)` at `jr-insert`
  * (`FormDef.createNewRepeat` fires `jr-insert` before any calculate), and `@current_index` is
  * `count(/data/held/item)`, which reads only the relevant rows (`XPathLazyNodeset.performEvaluation`). The hidden
  * second row leaves it at one, so the third row takes index 1 and the second row's record `b`, and `c` is in no
  * row. `counted` takes the placement Nova's rule gives a repeat with a condition, the count placement, whose rows
  * store their place from `position(..)` while the new row is relevant, so each keeps its own record. Catches a rule
  * that writes a repeat with a condition in model iteration. */
 @Test public void aHiddenRowShiftsModelIterationsLaterRowsButNotTheCountPlacements()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("query-hidden-row",source);FormDef form=parsed.getFormDef();enter(parsed,false);
   String held="/data/held/item",counted="/data/counted/item";
   assertEquals(3,held(form,held).size());
   assertFalse(relevant(form,held+"[2]"));
   assertEquals("a b b",stored(form,held+"[1]/@id")+" "+stored(form,held+"[2]/@id")+" "+stored(form,held+"[3]/@id"));
   assertEquals("0 1 1",stored(form,held+"[1]/@index")+" "+stored(form,held+"[2]/@index")+" "+stored(form,held+"[3]/@index"));
   assertEquals("a b",eval(form,"join(' ', "+held+"/record)"));
   assertEquals(3,held(form,counted).size());
   assertFalse(relevant(form,counted+"[2]"));
   assertEquals("0 1 2",stored(form,counted+"[1]/nova_query_index_counted")+" "+stored(form,counted+"[2]/nova_query_index_counted")+" "+stored(form,counted+"[3]/nova_query_index_counted"));
   assertEquals("a c",eval(form,"join(' ', "+counted+"/record)"));
  }
 }

 /** `container-query-nested-gated`: a count-placement `sites` query under a group shown only once `show` is yes,
  * and in each site a count-placement `plots` query reading that site's record. Nothing is made while the group
  * is not relevant; once it is, each site's rows are made with the ids of its own query, read on their first
  * evaluation (an absolute count inside a repeat resolves within the current outer row, `XFormParser`'s
  * `getAbsRef`). Catches ids computed across every outer row (a nested model iteration's failure, part 04 §1.2)
  * and a repeat left empty under a group that turns relevant during entry. */
 @Test public void nestedCountPlacementUnderALaterRelevantGroupGivesEachOuterRowItsOwnIds()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("query-nested-gated",source);FormDef form=parsed.getFormDef();
   enter(parsed,false);
   assertEquals(0.0,eval(form,"count(/data/page/sites/item)"));
   answer(form,"/data/show","yes");
   assertEquals(java.util.Map.of("0","s1","1","s2"),enterReading(parsed,"/data/page/sites/item","string(nova_query_id_sites)"));
   parsed=load("query-nested-gated",source);form=parsed.getFormDef();answer(form,"/data/show","yes");
   assertEquals(java.util.Map.of("0/0","p1","0/1","p2","1/0","p3"),enterReading(parsed,"/data/page/sites/item/plots/item","string(nova_query_id_plots)"));
   assertEquals("s1 s2",eval(form,"join(' ', /data/page/sites/item/site)"));
   assertEquals(2.0,eval(form,"count(/data/page/sites/item[1]/plots/item)"));
   assertEquals(1.0,eval(form,"count(/data/page/sites/item[2]/plots/item)"));
   assertEquals("p1 p2",eval(form,"join(' ', /data/page/sites/item[1]/plots/item/plot)"));
   assertEquals("p3",eval(form,"join(' ', /data/page/sites/item[2]/plots/item/plot)"));
  }
 }

 /** `container-init-add`'s `assets` is a count placement in each `visits` row, its query reading that row's
  * `zone`: a change in one outer row shrinks that row's results alone, its hidden rows keep their answers out of
  * the submission, and the change back restores them. Catches a nested count whose guard or ids leave the outer
  * row. */
 @Test public void aNestedCountPlacementShrinksAndGrowsWithinItsOuterRow()throws Exception {
  for(boolean source:new boolean[]{false,true}){
   FormParseInit parsed=load("init-add",source);FormDef form=parsed.getFormDef();enter(parsed,true);
   String assets="/data/visits[1]/assets/item";
   assertEquals("pump tap",eval(form,"join(' ', "+assets+"/row_id)"));
   answer(form,assets+"[1]/note","pump checked");answer(form,assets+"[2]/note","tap checked");
   answer(form,"/data/visits[1]/zone","south");enter(parsed,false);
   assertEquals(2,held(form,assets).size());
   assertEquals(1.0,eval(form,"count("+assets+")"));
   assertEquals("tap checked",stored(form,assets+"[2]/note"));
   assertEquals("tank",eval(form,"string("+assets+"[1]/row_id)"));
   assertEquals("pump checked",eval(form,"string("+assets+"[1]/note)"));
   assertFalse(relevant(form,assets+"[2]"));
   String xml=submission(form);
   assertTrue(xml.contains("pump checked"));assertFalse(xml.contains("tap checked"));
   answer(form,"/data/visits[1]/zone","north");enter(parsed,false);
   assertTrue(relevant(form,assets+"[2]"));
   assertEquals("pump tap",eval(form,"join(' ', "+assets+"/row_id)"));
   assertTrue(submission(form).contains("tap checked"));
  }
 }
}
