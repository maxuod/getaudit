// Text is the default evidence. Screenshots are taken only when explicitly requested.
async function captureArtifact(page, raw, captureScreenshot = false) {
  const text = {mime:'text/plain',base64:Buffer.from(JSON.stringify(raw,null,2)).toString('base64')};
  if (!captureScreenshot) return text;
  let bytes = await page.screenshot({type:'jpeg',quality:70,fullPage:true,timeout:12000}).catch(()=>null);
  if (!bytes || bytes.length > 4*1024*1024)
    bytes = await page.screenshot({type:'jpeg',quality:60,timeout:8000}).catch(()=>null);
  return bytes && bytes.length <= 4*1024*1024 ? {mime:'image/jpeg',base64:bytes.toString('base64')} : text;
}
module.exports = {captureArtifact};
