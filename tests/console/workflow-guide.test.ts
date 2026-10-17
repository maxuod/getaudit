import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {nextWorkflowAction,WorkflowGuide,type WorkflowFacts} from '../../apps/console/workflow-guide.tsx';
import {setUiLanguage} from '../../apps/console/i18n.tsx';

beforeEach(()=>setUiLanguage('zh-CN'));
afterEach(()=>setUiLanguage('en'));

const facts=(patch:Partial<WorkflowFacts>={}):WorkflowFacts=>({brand:'Sample Studio',set:'采购问题',questions:10,frozen:true,planned:30,recorded:0,answers:0,checked:0,qualified:0,eligible:0,attention:0,transferred:0,running:false,...patch});
describe('workflow guidance follows real evidence progress',()=>{
 it('starts with a project and asks for questions before a plan',()=>{
  expect(nextWorkflowAction(facts({brand:undefined,set:undefined,questions:0,planned:0}))).toBe('brand');
  expect(nextWorkflowAction(facts({set:undefined,questions:0,planned:0}))).toBe('questions');
 });
 it('requires review and freezing for a draft',()=>{
  expect(nextWorkflowAction(facts({frozen:false,planned:0}))).toBe('freeze');
  expect(nextWorkflowAction(facts({planned:0}))).toBe('plan');
 });
 it('opens results directly for automatically checked captures despite incomplete coverage',()=>{
  expect(nextWorkflowAction(facts({recorded:20,answers:15,checked:20,attention:5}))).toBe('report');
 });
 it('keeps running work actionable without treating saved records as success',()=>{
  expect(nextWorkflowAction(facts({recorded:20,checked:20,running:true}))).toBe('sampling');
 });
 it('permits reports with zero eligible evidence and partial coverage',()=>{
  expect(nextWorkflowAction(facts({recorded:20,answers:15,checked:20,eligible:0,attention:5}))).toBe('report');
 });
 it('keeps fully saved failures distinct from completed successful sampling',()=>{
  const markup=renderToStaticMarkup(React.createElement(WorkflowGuide,{facts:facts({recorded:30,answers:20,checked:30,attention:10}),page:'workspace',onNavigate:()=>{},onAction:()=>{}}));
  expect(markup).toContain('30 / 30 已记录');
  expect(markup).toContain('30 条已自动检查');
  expect(markup).toContain('10 个任务有访问、错误或条件说明');
  expect(markup).toMatch(/workflow-step has-attention[^>]*aria-current="step"/);
  expect(markup).not.toMatch(/workflow-step is-done[^>]*aria-current="step"/);
 });
 it('makes every stage reachable and labels the selected stage independently of progress',()=>{
  const markup=renderToStaticMarkup(React.createElement(WorkflowGuide,{facts:facts({recorded:1,checked:1}),page:'reports',onNavigate:()=>{},onAction:()=>{}}));
  expect((markup.match(/class="workflow-step/g)??[]).length).toBe(6); // ol plus five actual stages
  expect(markup).toContain('aria-current="step"');
  expect(markup).toContain('0 条可计入指标');
  expect(markup).toContain('查看结果');expect(markup).not.toContain('待复核');
 });
});
