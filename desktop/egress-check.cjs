const {createHash}=require('node:crypto');
const {isIP}=require('node:net');
const TRACE='https://www.cloudflare.com/cdn-cgi/trace';
const guard=message=>Object.assign(new Error(message),{code:'EGRESS_GUARD'});
function parseEgress(text,planId,targetCountry="CA"){
  if(!/^[A-Z]{2}$/.test(targetCountry))throw guard("目标国家代码无效；未提交问题");
  const fields=Object.fromEntries(String(text).split(/\r?\n/).filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
  if(!isIP(fields.ip||'')||!/^\d+(\.\d+)?$/.test(fields.ts||''))throw guard('出口核验未返回有效网络证据；未提交问题');
  if(fields.loc!==targetCountry)throw guard(`出口国家为 ${/^[A-Z]{2}$/.test(fields.loc||'')?fields.loc:'未知'}，需要 ${targetCountry} 出口；未提交问题`);
  if(Math.abs(Date.now()-Number(fields.ts)*1000)>120000)throw guard('出口核验记录已过期；未提交问题');
  return {country:targetCountry,fingerprint:createHash('sha256').update(planId+'\0'+fields.ip).digest('hex'),verifiedAt:new Date().toISOString(),provider:'cloudflare_trace'};
}
async function verifyContextEgress(context,planId,targetCountry="CA"){
  const page=await context.newPage();
  try{
    const response=await page.goto(TRACE+'?check='+Date.now(),{waitUntil:'domcontentloaded',timeout:15000});
    if(!response?.ok()||new URL(page.url()).origin!==new URL(TRACE).origin)throw guard('出口核验服务不可用；未提交问题');
    return parseEgress(await page.locator('body').innerText(),planId,targetCountry);
  }catch(error){if(error.code==='EGRESS_GUARD')throw error;throw guard('目标国家出口核验失败；请检查网络，未提交问题');}
  finally{await page.close().catch(()=>{});}
}
module.exports={parseEgress,verifyContextEgress};
