import {describe,it,expect} from 'vitest';
import {conditionIssues,planSchema,type PlanConfig,type CaptureRecord} from '../../src/console/contracts.ts';
const plan:PlanConfig={promptSetId:'test',label:'Synthetic privacy',surfaces:['chatgpt_search','google_aio'],windows:['2026-09-26'],country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop',accountMode:'signed_in_private'};
const capture:CaptureRecord={slotId:'test',prompt:'Synthetic question',status:'observed',reason:'',restriction:'none',observedAt:'2026-09-26T16:00:00Z',answer:'Synthetic answer',citations:[],model:'unknown',account:'logged_in',session:'active',exitCountry:'CA',geo:'ip_observed',locale:'en-CA',timezone:'UTC',device:'desktop',geolocation:'denied',searchMode:'explicit_search',collectionMode:'manual_capture',artifactHash:'fixture',privacy:{mode:'signed_in_private',temporaryChat:'verified',personalization:'disabled',newConversation:true}};
describe('account and conversation evidence isolation',()=>{
  it('requires positive temporary chat and personalization evidence for logged-in ChatGPT',()=>{
    expect(conditionIssues(plan,capture,'chatgpt_search')).toEqual([]);
    expect(conditionIssues(plan,{...capture,privacy:undefined},'chatgpt_search').length).toBeGreaterThan(0);
    expect(conditionIssues(plan,{...capture,privacy:{...capture.privacy!,temporaryChat:'not_applicable'}},'chatgpt_search')).toContain('临时对话未确认');
    expect(conditionIssues(plan,{...capture,privacy:{...capture.privacy!,personalization:'unknown'}},'chatgpt_search')).toContain('个性化未确认关闭');
  });
  it('permits Google non-personalized new searches without inventing a Temporary Chat feature',()=>{
    expect(conditionIssues(plan,{...capture,privacy:{...capture.privacy!,temporaryChat:'not_applicable'}},'google_aio')).toEqual([]);
  });
  it('never mixes signed-in samples into the signed-out baseline or the reverse',()=>{
    expect(conditionIssues({...plan,accountMode:'signed_out'},capture,'chatgpt_search')).toContain('登录态样本不能混入未登录基线');
    expect(conditionIssues(plan,{...capture,account:'logged_out',session:'fresh'},'chatgpt_search')).toContain('未确认登录态独立采样条件');
    expect(conditionIssues(plan,{...capture,privacy:{...capture.privacy!,newConversation:false}},'chatgpt_search')).toContain('未确认新对话或新搜索页面');
  });
  it('retains legacy plan compatibility and rejects unsupported logged-in Gemini',()=>{
    expect(planSchema.safeParse({...plan,accountMode:undefined}).success).toBe(true);
    expect(planSchema.safeParse({...plan,surfaces:['gemini']}).success).toBe(false);
  });
});
