import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import React,{act} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {createRoot} from "react-dom/client";
import {parseHTML} from "linkedom";
import {BrowserLoginSetup} from "../../apps/console/browser-login-setup.tsx";
import {BrowserPanel} from "../../apps/console/browser-panel.tsx";
import {request} from "../../apps/console/api.ts";
import type {BrowserJobs} from "../../src/console/browser-jobs.ts";
import type {LabService} from "../../src/console/service.ts";
import {surfaces} from "../../src/console/contracts.ts";
import {setUiLanguage} from "../../apps/console/i18n.tsx";

beforeEach(()=>setUiLanguage('zh-CN'));
afterEach(()=>setUiLanguage('en'));

vi.mock("../../apps/console/api.ts",()=>({request:vi.fn()}));
vi.mock("../../apps/console/download.ts",()=>({downloadText:vi.fn()}));
type Readiness=ReturnType<BrowserJobs["loginReadiness"]>;
type Platform=Readiness["platforms"][number];
const plan=(accountMode="isolated",id="plan-one")=>({id,label:"Login reminder fixture",config:{accountMode,surfaces:["gemini","grok"],windows:["2026-10-11"],timezone:"UTC"},slots:[]}) as unknown as ReturnType<LabService["plan"]>;
function platform(surface:keyof typeof surfaces,status:Platform["status"],extra:Partial<Platform>={}):Platform {
  const required=["login_required","not_configured","awaiting_confirmation"].includes(status);
  return {surface,name:surfaces[surface].name,url:surfaces[surface].url,status,required,canConfigure:true,needsNewPlan:false,sessionOpen:status==="awaiting_confirmation"||status==="confirmed",confirmed:status==="confirmed",blockedCount:required?3:0,reason:required?"已保存的网页记录确认需要登录。":"没有需要登录的记录。",restriction:{active:status==="login_required"||status==="restricted",type:status==="login_required"?"login":status==="restricted"?"captcha":null,reason:"已保存的限制证据",evidence:null},previousLoginEvidence:null,...extra};
}
const readiness=(items:Platform[],accountMode="isolated",planId="plan-one"):Readiness=>({planId,accountMode,ready:items.every(item=>!item.required||item.confirmed),samplingActive:false,sessionInspectionAvailable:true,note:"Synthetic UI fixture",platforms:items}) as Readiness;
const defaults={plan:plan(),sessions:[],availability:{available:true,message:"Chrome available"},busy:false,samplingActive:false,act:async(fn:()=>Promise<unknown>)=>{await fn();},onPause:vi.fn(async()=>{})};
async function mount(props:Partial<React.ComponentProps<typeof BrowserLoginSetup>>={}){
  const {window,document}=parseHTML('<html><body><main id="root"></main></body></html>');
  vi.stubGlobal("window",window);vi.stubGlobal("document",document);vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const root=createRoot(document.getElementById("root")! as unknown as HTMLElement);
  await act(async()=>{root.render(React.createElement(BrowserLoginSetup,{...defaults,...props}));});
  const click=async(label:string)=>{
    const button=Array.from(document.querySelectorAll("button")).find(node=>node.textContent?.includes(label));
    expect(button,label).toBeTruthy();
    await act(async()=>{button!.dispatchEvent(new window.Event("click",{bubbles:true}));});
  };
  return {root,document,click,render:async(next:Partial<React.ComponentProps<typeof BrowserLoginSetup>>)=>{await act(async()=>{root.render(React.createElement(BrowserLoginSetup,{...defaults,...props,...next}));});}};
}
describe("sampling platform login configuration",()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.mocked(request).mockReset();defaults.onPause.mockClear();});
  it("shows a named login reminder and keeps CAPTCHA separate from login",()=>{
    const html=renderToStaticMarkup(React.createElement(BrowserLoginSetup,{...defaults,readiness:readiness([platform("gemini","login_required"),platform("grok","restricted",{required:true})])}));
    expect(html).toContain("AI 平台登录配置");
    expect(html).toContain("以下平台需要登录配置");
    expect(html).toContain("3 个任务暂停");
    expect(html).toContain("其他入口限制");
    expect(html).toContain("登录配置不会解除验证码、频率或地区限制。");
    expect((html.match(/去登录配置/g)??[])).toHaveLength(1);
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });
  it("navigates to the affected platform without opening a browser or submitting a question",async()=>{
    const ui=await mount({readiness:readiness([platform("gemini","login_required"),platform("grok","optional")])});
    try{
      expect(ui.document.querySelector("details")!.hasAttribute("open")).toBe(false);
      await ui.click("去登录配置");
      expect(ui.document.querySelector("details")!.hasAttribute("open")).toBe(true);
      expect(ui.document.querySelector('[data-highlighted="true"]')!.textContent).toContain("Gemini");
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("opens and confirms only on separate user clicks and leaves continuation manual",async()=>{
    vi.mocked(request).mockResolvedValue({opened:true,verified:true,restrictionReleased:true});
    const initial=readiness([platform("gemini","login_required")]);
    const ui=await mount({readiness:initial});
    try{
      await ui.click("去登录配置");
      expect(vi.mocked(request)).not.toHaveBeenCalled();
      await ui.click("打开登录窗口");
      expect(vi.mocked(request).mock.calls).toEqual([["browser-session",{planId:"plan-one",surface:"gemini",action:"open"}]]);
      await ui.render({readiness:readiness([platform("gemini","awaiting_confirmation")]),sessions:[{planId:"plan-one",surface:"gemini",verified:false}]});
      await ui.click("确认登录");
      expect(vi.mocked(request).mock.calls[1]).toEqual(["browser-session",{planId:"plan-one",surface:"gemini",action:"verify"}]);
      expect(ui.document.body.textContent).toContain("可手动继续未提交任务");
      expect(vi.mocked(request).mock.calls).toHaveLength(2);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==="browser-control"||path==="browser-jobs")).toBe(false);
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("allows navigation while sampling but requires pause before opening a login window",async()=>{
    const ui=await mount({samplingActive:true,activeJob:{id:"job-one",status:"running",finalizing:false},readiness:readiness([platform("gemini","login_required",{canConfigure:false})])});
    try{
      await ui.click("去登录配置");
      expect(ui.document.body.textContent).toContain("先暂停本批采样");
      const open=Array.from(ui.document.querySelectorAll("button")).find(button=>button.textContent?.includes("打开登录窗口"));
      expect(open!.hasAttribute("disabled")).toBe(true);
      await ui.click("暂停采样");
      expect(defaults.onPause).toHaveBeenCalledExactlyOnceWith("job-one");
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("routes a frozen signed-out plan to explicit new-plan configuration without changing its conditions",async()=>{
    const create=vi.fn(),frozen=plan("signed_out");
    const ui=await mount({plan:frozen,onCreateLoginPlan:create,readiness:readiness([platform("gemini","login_required",{canConfigure:false,needsNewPlan:true})],"signed_out")});
    try{
      await ui.click("去登录配置");
      expect(ui.document.body.textContent).toContain("当前计划已冻结为未登录条件");
      expect(create).not.toHaveBeenCalled();
      await ui.click("配置新登录计划");
      expect(create).toHaveBeenCalledOnce();
      expect(frozen.config.accountMode).toBe("signed_out");
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("supports direct navigation from connection settings without a browser action",async()=>{
    const ui=await mount({readiness:readiness([platform("gemini","optional")])});
    try{
      await ui.render({loginSetupRequest:1});
      expect(ui.document.querySelector("details")!.hasAttribute("open")).toBe(true);
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("does not show the previous plan's readiness after selecting another plan",async()=>{
    const ui=await mount({readiness:readiness([platform("gemini","login_required")])});
    try{
      expect(ui.document.body.textContent).toContain("以下平台需要登录配置");
      await ui.render({plan:plan("isolated","plan-two")});
      expect(ui.document.body.textContent).not.toContain("以下平台需要登录配置");
      expect(ui.document.body.textContent).toContain("可选 · 尚未检查");
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("keeps an active login restriction visible even when its prepared window was previously confirmed",async()=>{
    vi.mocked(request).mockResolvedValue({verified:true});
    const ui=await mount({readiness:readiness([platform("gemini","confirmed",{required:true,restriction:{active:true,type:"login",reason:"Still has saved login restriction",evidence:null}})])});
    try{
      expect(ui.document.body.textContent).toContain("登录已确认 · 需再次确认");
      await ui.click("去登录配置");
      const confirm=Array.from(ui.document.querySelectorAll("button")).find(button=>button.textContent==="确认登录");
      expect(confirm!.hasAttribute("disabled")).toBe(false);
      await ui.click("确认登录");
      expect(vi.mocked(request).mock.calls).toEqual([["browser-session",{planId:"plan-one",surface:"gemini",action:"verify"}]]);
      expect(ui.document.body.textContent).toContain("登录已确认，但此入口的限制尚未解除");
    }finally{await act(async()=>ui.root.unmount());}
  });
  it.each([{}, {verified:false}])("does not claim login confirmation for an unverified response %j",async(response)=>{
    vi.mocked(request).mockResolvedValue(response);
    const ui=await mount({readiness:readiness([platform("gemini","awaiting_confirmation")])});
    try{
      await ui.click("去登录配置");
      await ui.click("确认登录");
      expect(ui.document.body.textContent).toContain("登录尚未确认。");
      expect(ui.document.querySelector(".browser-login-message.warning")).not.toBeNull();
      expect(ui.document.body.textContent).not.toContain("登录已确认。可手动继续");
    }finally{await act(async()=>ui.root.unmount());}
  });
  it.each([{}, {opened:false}])("does not claim that a login window opened without a positive acknowledgement %j",async(response)=>{
    vi.mocked(request).mockResolvedValue(response);
    const ui=await mount({readiness:readiness([platform("gemini","login_required")])});
    try{
      await ui.click("去登录配置");
      await ui.click("打开登录窗口");
      expect(ui.document.body.textContent).toContain("登录窗口尚未确认打开");
      expect(ui.document.body.textContent).not.toContain("已打开 Gemini 登录窗口");
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("does not promise that confirmed login resolves an unrelated platform restriction",async()=>{
    vi.mocked(request).mockResolvedValue({verified:true,restrictionReleased:false});
    const ui=await mount({readiness:readiness([platform("gemini","restricted",{sessionOpen:true,confirmed:false,required:true})])});
    try{
      await ui.click("AI 平台登录配置");
      await ui.click("确认登录");
      expect(ui.document.body.textContent).toContain("此入口的限制尚未解除");
      expect(ui.document.body.textContent).toContain("可手动继续其他未受限平台");
      expect(ui.document.body.textContent).not.toContain("登录已确认。可手动继续未提交任务");
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("keeps other unrestricted isolated lanes available while reminding the user about a login-limited platform",()=>{
    const jobs=[{id:"job-one",plan_id:"plan-one",status:"paused",finalizing:false,captured:0,total:3,remaining:3,attention:1,failedRecords:0,counts:{pending:2,blocked:1},lanes:[],currents:[],message:"Synthetic paused run",config:{executionMode:"serial",intervalSeconds:5,browserMode:"silent",captureScreenshot:false},resume:{current:2,expired:0,date:"2026-10-11"}}] as unknown as ReturnType<BrowserJobs["rows"]>;
    const html=renderToStaticMarkup(React.createElement(BrowserPanel,{plan:plan(),jobs,sessions:[],loginReadiness:readiness([platform("gemini","login_required"),platform("grok","optional")]),availability:defaults.availability,reload:async()=>{},select:()=>{},selectPlan:()=>{}}));
    const {document}=parseHTML(html);
    expect(document.querySelector("button.primary")!.hasAttribute("disabled")).toBe(false);
    expect(html).toContain("可继续其他未受限平台");
    expect(html).toContain("以下平台需要登录配置");
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });
  it("preserves the mandatory current-day preparation gate for signed-in private plans",()=>{
    const jobs=[{id:"job-one",plan_id:"plan-one",status:"paused",finalizing:false,captured:0,total:3,remaining:3,attention:1,failedRecords:0,counts:{pending:2,blocked:1},lanes:[],currents:[],message:"Synthetic paused run",config:{executionMode:"serial",intervalSeconds:5,browserMode:"silent",captureScreenshot:false},resume:{current:2,expired:0,date:"2026-10-11"}}] as unknown as ReturnType<BrowserJobs["rows"]>;
    const html=renderToStaticMarkup(React.createElement(BrowserPanel,{plan:plan("signed_in_private"),jobs,sessions:[],loginReadiness:readiness([platform("gemini","not_configured"),platform("grok","not_configured")],"signed_in_private"),availability:defaults.availability,reload:async()=>{},select:()=>{},selectPlan:()=>{}}));
    const {document}=parseHTML(html);
    expect(document.querySelector("button.primary")!.hasAttribute("disabled")).toBe(true);
    expect(html).toContain("先完成下方提示的平台登录配置");
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });
  it("offers a new isolated plan for a confirmed private window with an unreleased shared login stop instead of a reconfirmation loop",async()=>{
    const create=vi.fn();
    const ui=await mount({plan:plan("signed_in_private"),onCreateLoginPlan:create,readiness:readiness([platform("gemini","confirmed",{required:true,restriction:{active:true,type:"login",reason:"Shared signed-out restriction remains",evidence:null}})],"signed_in_private")});
    try{
      expect(ui.document.body.textContent).toContain("登录窗口已确认 · 原限制保留");
      expect(ui.document.body.textContent).not.toContain("需再次确认");
      await ui.click("去登录配置");
      const confirmation=Array.from(ui.document.querySelectorAll(".browser-login-actions button")).find(button=>button.textContent==="已确认");
      expect(confirmation!.hasAttribute("disabled")).toBe(true);
      expect(create).not.toHaveBeenCalled();
      await ui.click("配置新独立登录计划");
      expect(create).toHaveBeenCalledOnce();
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>ui.root.unmount());}
  });
  it("lets an expired private plan continue into a new date and suppresses old-plan login preparation",()=>{
    const jobs=[{id:"job-one",plan_id:"plan-one",status:"paused",finalizing:false,captured:0,total:3,remaining:3,attention:1,failedRecords:0,counts:{pending:2,blocked:1},lanes:[],currents:[],message:"Synthetic expired paused run",config:{executionMode:"serial",intervalSeconds:5,browserMode:"silent",captureScreenshot:false},resume:{current:0,expired:2,date:"2026-10-12"}}] as unknown as ReturnType<BrowserJobs["rows"]>;
    const html=renderToStaticMarkup(React.createElement(BrowserPanel,{plan:plan("signed_in_private"),jobs,sessions:[],loginReadiness:readiness([platform("gemini","not_configured")],"signed_in_private"),availability:defaults.availability,reload:async()=>{},select:()=>{},selectPlan:()=>{}}));
    const {document}=parseHTML(html);
    expect(document.querySelector("button.primary")!.hasAttribute("disabled")).toBe(false);
    expect(html).toContain("先继续未提交任务，再配置新日期的登录");
    expect(html).toContain("先点击“继续采样”建立新日期续采计划");
    expect(html).not.toContain("以下平台需要登录配置");
    expect(html).not.toContain("去登录配置");
    expect(Array.from(document.querySelectorAll(".browser-login-actions button")).every(button=>button.hasAttribute("disabled"))).toBe(true);
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });
});
