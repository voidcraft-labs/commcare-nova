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
    if(!"commcaresession".equals(instance.getInstanceId()))throw new AssertionError(instance.getInstanceId());
    TreeElement root=node("session",null), context=node("context",null), data=node("data",null);
    for(String key:new String[]{"deviceid","username","userid","appversion"})context.addChild(node(key,"fixture-"+key));
    context.addChild(node("drift","0"));data.addChild(node("case_id_new_patient_0","new-patient"));
    root.addChild(context);root.addChild(data);
    InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),new InstanceBase(instance.getInstanceId()));
    return new ConcreteInstanceRoot(root);
   }
  };
 }
 private static Object eval(FormDef form,String expression)throws Exception{return ExprEvalUtils.xpathEval(form.getEvaluationContext(),expression);}
 private static FormParseInit load(String scenario,boolean source)throws Exception{
  FormParseInit parsed=new FormParseInit("/container-"+scenario+(source?".hq.xml":".xml"));
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
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"user","path","literal","expression","cousins","query","nested-query","path-late","nested-count"}){
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();enter(parsed,"user".equals(scenario));
   switch(scenario){
    case "user":assertEquals(1.0,eval(form,"count(/data/items)"));break;
    case "path-late":
    case "path":assertEquals(2.0,eval(form,"count(/data/items)"));break;
    case "literal":assertEquals(3.0,eval(form,"count(/data/items)"));break;
    case "expression":assertEquals(4.0,eval(form,"count(/data/items)"));break;
    case "cousins":assertEquals(3.0,eval(form,"count(/data/one/items)"));assertEquals(5.0,eval(form,"count(/data/two/items)"));break;
    case "query":assertEquals(3.0,eval(form,"count(/data/items/item)"));assertEquals("a b c",eval(form,"join(' ', /data/items/item/item_id)"));break;
    case "nested-count":
     assertEquals(2.0,eval(form,"count(/data/parents/item[1]/items)"));
     assertEquals(3.0,eval(form,"count(/data/parents/item[2]/items)"));break;
    case "nested-query":
     assertEquals(2.0,eval(form,"count(/data/items/item)"));
     assertEquals(2.0,eval(form,"count(/data/items/item[1]/children/item)"));
     assertEquals(1.0,eval(form,"count(/data/items/item[2]/children/item)"));
     assertEquals("a1 a2",eval(form,"join(' ', /data/items/item[1]/children/item/item_id)"));
     assertEquals("b1",eval(form,"join(' ', /data/items/item[2]/children/item/item_id)"));break;
   }
  }
 }
 @Test public void allCountsKeepTheirInitialValueWhenAnswersChange()throws Exception {
  for(boolean source:new boolean[]{false,true})for(String scenario:new String[]{"path","expression"}) {
   FormParseInit parsed=load(scenario,source);FormDef form=parsed.getFormDef();
   org.javarosa.xpath.XPathNodeset size=(org.javarosa.xpath.XPathNodeset)org.javarosa.xpath.XPathParseTool.parseXPath("/data/size").eval(form.getMainInstance(),form.getEvaluationContext());
   form.setValue(new org.javarosa.core.model.data.IntegerData(5),size.getRefAt(0));
   enter(parsed,false);
   assertEquals("path".equals(scenario)?2.0:4.0,eval(form,"count(/data/items)"));
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

 @Test public void directSnapshotPreservesStrictLexicalCountConversion()throws Exception {
  String[] values={"", "0", "2", "2.0", " 2 ", "-1", "٢", "NaN", "2147483648"};
  String[] expected={"0.0", "0.0", "2.0", "invalid", "invalid", "0.0", "2.0", "invalid", "invalid"};
  for(int i=0;i<values.length;i++)for(boolean direct:new boolean[]{false,true}) {
   javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
   org.w3c.dom.Document document;
   try(java.io.InputStream stream=getClass().getResourceAsStream("/container-path.xml")){document=factory.newDocumentBuilder().parse(stream);}
   org.w3c.dom.NodeList nodes=document.getElementsByTagName("*");
   for(int n=0;n<nodes.getLength();n++) {
    org.w3c.dom.Element element=(org.w3c.dom.Element)nodes.item(n);
    if("bind".equals(element.getLocalName())&&"/data/size".equals(element.getAttribute("nodeset")))element.setAttribute("type","xsd:string");
    if("setvalue".equals(element.getLocalName())&&"/data/size".equals(element.getAttribute("ref")))element.setAttribute("value","'"+values[i]+"'");
    if(direct&&"repeat".equals(element.getLocalName()))element.setAttributeNS("http://openrosa.org/javarosa","jr:count","/data/size");
   }
   java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
   javax.xml.transform.TransformerFactory.newInstance().newTransformer().transform(new javax.xml.transform.dom.DOMSource(document),new javax.xml.transform.stream.StreamResult(bytes));
   String actual;
   try(java.io.InputStream input=new java.io.ByteArrayInputStream(bytes.toByteArray())) {
    FormDef form=org.javarosa.xform.util.XFormUtils.getFormFromInputStream(input);form.initialize(true,environment());
    enter(new FormParseInit(form),false);actual=eval(form,"count(/data/items)").toString();
   }catch(org.javarosa.xpath.XPathTypeMismatchException error){actual="invalid";}
   assertEquals("lexical="+values[i]+", originalDirect="+direct,expected[i],actual);
  }
 }

 @Test public void laterAuthoredDefaultsExistBeforeCountSnapshot()throws Exception {
  FormParseInit parsed=load("path-late",false);enter(parsed,false);
  assertEquals(2.0,eval(parsed.getFormDef(),"count(/data/items)"));
 }
 @Test public void countSnapshotsUseEachEnclosingRepeatRow()throws Exception {
  FormParseInit parsed=load("nested-count",false);enter(parsed,false);
  assertEquals(2.0,eval(parsed.getFormDef(),"count(/data/parents/item[1]/items)"));
  assertEquals(3.0,eval(parsed.getFormDef(),"count(/data/parents/item[2]/items)"));
 }

}
