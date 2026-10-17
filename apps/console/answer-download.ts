import {request} from './api.ts';
import {downloadText} from './download.ts';
import {getUiLanguage} from './i18n.tsx';
export async function downloadAnswers(planId:string){
  const result=await request<{filename:string;markdown:string}>('answers-markdown?id='+encodeURIComponent(planId)+'&uiLocale='+getUiLanguage());
  downloadText(result.filename,result.markdown,'text/markdown;charset=utf-8');
}
