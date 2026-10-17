/** Offline extraction. Rewrites are proposals, never attributed to a customer. */
export const questionExtractorVersion = 'local-questions-v1';
export type QuestionStage = 'comparison' | 'price' | 'implementation' | 'research';
export type ExtractedQuestion = {text:string; original:string; derivation:'verbatim'|'keyword_rewrite'; stage:QuestionStage};
export function questionKey(text:string) {
  return text.normalize('NFKC').trim().toLowerCase().replace(/[?？]+$/u,'').replace(/[“”"‘’]/gu,'').replace(/\s+/g,' ').trim();
}
export function questionStage(text:string):QuestionStage {
  if(/\b(?:versus|vs|compare|comparison|alternative|best|choose|switch|replace)\b|\bbetter than\b|比较|对比|替代|推荐|选择|更换/i.test(text))return 'comparison';
  if(/\b(?:price|pricing|cost|budget|fee|afford(?:able)?|expensive|cheaper|cheap)\b|价格|多少钱|费用|预算|收费/i.test(text))return 'price';
  if(/\b(?:integrat\w*|migrat\w*|setup|implement\w*|import|export|connect)\b|集成|迁移|导入|对接|接入/i.test(text))return 'implementation';
  return 'research';
}
function clean(text:string) {return text.trim().replace(/^(?:[-*•]|\d+[.)、])\s*/,'').replace(/^(?:customer|client|user|buyer|客户|用户|买家)\s*[:：]\s*/i,'').trim();}
export function isQuestion(text:string) {
  return /[?？]$/.test(text)||/^(?:how|what|which|where|when|why|who|whose|can|could|would|should|does|do|is|are|will|how much)\b/i.test(text)||/^(?:如何|怎样|怎么|为什么|哪种|哪个|哪些|是否|能否|多少钱)/.test(text)||/[吗呢]$/.test(text);
}
export function extractQuery(raw:string):ExtractedQuestion|null {
  const query=clean(raw);
  if(query.length<4||query.length>1000||/^[\w.+-]+@|https?:\/\/|www\.|^[=+@]|^\d+$|\b(?:login|log in|sign in|download)\b|登录|登入/i.test(query))return null;
  if(isQuestion(query))return {text:query,original:raw,derivation:'verbatim',stage:questionStage(query)};
  const chinese=/[\u3400-\u9fff]/.test(query),stage=questionStage(query);
  let text:string|undefined;
  const comparison=/^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i.exec(query);
  if(comparison)text=`How does ${comparison[1]} compare with ${comparison[2]}?`;
  else if(chinese){
    if(stage==='price')text=`关于“${query}”，费用是多少，包含哪些服务？`;
    else if(stage==='comparison')text=`关于“${query}”，有哪些区别和选择依据？`;
    else if(stage==='implementation')text=`如何解决“${query}”的接入或实施问题？`;
    else if(/计算器|计算|软件|工具|排班|小费/.test(query))text=`如何处理“${query}”这个需求？`;
  }else{
    if(stage==='price'){const topic=query.replace(/\b(?:price|pricing|cost|costs|fees?)\b/gi,'').replace(/\s+/g,' ').trim();if(topic)text=`What does ${topic} cost, and what is included?`;}
    else if(/\balternatives?\b/i.test(query)){const topic=query.replace(/\balternatives?\s*(?:to|for)?\b/gi,'').replace(/\s+/g,' ').trim();if(topic)text=`What are the alternatives to ${topic}?`;}
    else if(stage==='comparison'){const topic=query.replace(/\bbest\b/gi,'').replace(/\s+/g,' ').trim();if(topic)text=`What should I compare when choosing ${topic}?`;}
    else if(stage==='implementation')text=`What should I check before implementing ${query}?`;
    else if(/\bcalculator\b/i.test(query)){const topic=query.replace(/\bcalculator\b/gi,'').replace(/\s+/g,' ').trim();if(topic)text=`How can I calculate ${topic} accurately?`;}
    else if(/\b(?:software|tools?|apps?|systems?)\b/i.test(query))text=`What should I consider when choosing ${query}?`;
  }
  return text?{text,original:raw,derivation:'keyword_rewrite',stage}:null;
}
export function extractRecord(raw:string):ExtractedQuestion[] {
  const found=new Map<string,ExtractedQuestion>();
  for(const line of raw.replace(/\r\n?/g,'\n').split('\n')){
    const segments=line.match(/[^?？]+[?？]/g)??[line];
    for(const segment of segments){const text=clean(segment);if(text.length<4||text.length>3000||!isQuestion(text))continue;
      const key=questionKey(text);if(!found.has(key))found.set(key,{text,original:segment.trim(),derivation:'verbatim',stage:questionStage(text)});
    }
  }
  return [...found.values()];
}
