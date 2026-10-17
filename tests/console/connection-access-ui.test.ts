import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseHTML} from 'linkedom';
import {ConnectionAccessNotice,ConnectionSettingsEditor,useConnectionAccessPolling,type ConnectionAccess} from '../../apps/console/connection-access.tsx';
import {setUiLanguage} from '../../apps/console/i18n.tsx';

beforeEach(()=>setUiLanguage('zh-CN'));

const fields=[{key:'OPENAI_API_KEY',label:'OpenAI API Key',configured:true,secret:true}];
function mountDocument() {
  const {window,document}=parseHTML('<html><body><main id="root"></main></body></html>');
  vi.stubGlobal('window',window);vi.stubGlobal('document',document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  return {window,document,root:createRoot(document.getElementById('root')! as unknown as HTMLElement)};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();setUiLanguage('en');});

describe('connection access interface',()=>{
  it('keeps existing fixtures editable when optional access state is absent',()=>{
    const html=renderToStaticMarkup(React.createElement(ConnectionSettingsEditor,{fields,persisted:true,busy:false,onUnlock:vi.fn(),onSave:vi.fn()}));
    expect(html).toContain('OpenAI API Key · 已配置');
    expect(html).toContain('保存配置');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('解锁连接');
  });
  it('uses bounded messages rather than exposing server errors or secrets',()=>{
    const html=renderToStaticMarkup(React.createElement(ConnectionAccessNotice,{access:{status:'locked',message:'SECRET_CANARY: raw keychain error'},onUnlock:vi.fn()}));
    expect(html).toContain('已保存连接尚未解锁');
    expect(html).toContain('仍可浏览历史台账与报告');
    expect(html).not.toContain('SECRET_CANARY');
  });
  it.each(['loading','locked'] as const)('prevents overwriting saved credentials while %s, even on a direct submit',async status=>{
    const {window,document,root}=mountDocument(),save=vi.fn(),unlock=vi.fn();
    try {
      await act(async()=>{root.render(React.createElement(ConnectionSettingsEditor,{access:{status},fields,persisted:true,busy:false,onUnlock:unlock,onSave:save}));});
      expect(document.querySelector('input')!.hasAttribute('disabled')).toBe(true);
      expect([...document.querySelectorAll('button')].find(button=>button.textContent==='保存配置')!.hasAttribute('disabled')).toBe(true);
      expect(document.body.textContent).toContain('现有密钥会保留');
      await act(async()=>{document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});
      expect(save).not.toHaveBeenCalled();
      expect(unlock).not.toHaveBeenCalled();
      if(status==='locked') {
        await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent==='解锁连接')!.dispatchEvent(new window.Event('click',{bubbles:true}));});
        expect(unlock).toHaveBeenCalledTimes(1);
      } else expect(document.body.textContent).not.toContain('解锁连接');
    } finally {await act(async()=>root.unmount());}
  });
  it('polls state only while loading and stops on ready, locked or unmount',async()=>{
    vi.useFakeTimers();
    const {root}=mountDocument(),reload=vi.fn(async()=>{});
    function Probe({access}:{access?:ConnectionAccess}){useConnectionAccessPolling(access,reload,'selected');return null;}
    const render=async(access?:ConnectionAccess)=>{await act(async()=>root.render(React.createElement(Probe,{access})));};
    try {
      await render({status:'loading'});
      await act(async()=>{await vi.advanceTimersByTimeAsync(4100);});
      expect(reload).toHaveBeenCalledTimes(2);
      await render({status:'ready'});
      await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
      expect(reload).toHaveBeenCalledTimes(2);
      await render({status:'loading'});
      await act(async()=>{await vi.advanceTimersByTimeAsync(2100);});
      expect(reload).toHaveBeenCalledTimes(3);
      await render({status:'locked'});
      await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
      expect(reload).toHaveBeenCalledTimes(3);
      await render({status:'loading'});
      await act(async()=>root.unmount());
      await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
      expect(reload).toHaveBeenCalledTimes(3);
    } finally {await act(async()=>root.unmount());}
  });
  it('does not queue multiple state reads while the previous read is pending',async()=>{
    vi.useFakeTimers();
    const {root}=mountDocument();let finish!:()=>void;
    const reload=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    function Probe(){useConnectionAccessPolling({status:'loading'},reload,'selected');return null;}
    try {
      await act(async()=>root.render(React.createElement(Probe)));
      await act(async()=>{await vi.advanceTimersByTimeAsync(8000);});
      expect(reload).toHaveBeenCalledTimes(1);
      await act(async()=>{finish();});
      await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {await act(async()=>root.unmount());}
  });
});
