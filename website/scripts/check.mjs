import {readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {copy,tours} from '../src/content.mjs';
import {siteConfig,configureContent} from '../src/config.mjs';
import {buildStructuredData,serializeStructuredData} from '../src/schema.mjs';

const root=resolve('dist'),failures=[],pages=[];
const scan=directory=>{for(const item of readdirSync(directory,{withFileTypes:true})){const file=join(directory,item.name);if(item.isDirectory())scan(file);else if(file.endsWith('.html'))pages.push(file);}};
scan(root);
const assertion=(ok,message)=>{if(!ok)failures.push(message);};
const source=readFileSync('dist/index.html','utf8'),privacy=readFileSync('dist/privacy/index.html','utf8');
const policy=configureContent(JSON.parse(readFileSync('content/privacy.json','utf8')));
const browserSchema=await import('../dist/assets/schema.js');
const browserContent=await import('../dist/assets/content.js');
const browserPolicy=(await import('../dist/assets/privacy-content.js')).policy;
const origin=process.env.SITE_ORIGIN??siteConfig.origin;
const publicSite=(process.env.SITE_PUBLIC??(siteConfig.publicIndexing?'1':'0'))==='1';
assertion(copy.en.title==='getaudit — All-in-one GEO tools','The canonical English product name is wrong.');
assertion(source.includes('<span>getaudit<span class="brand-domain">.si</span>'),'The getaudit.si wordmark is missing.');
assertion(copy.en.sample==='Actual product interface · Fictional sample data','The fictional-data screenshot caption is missing.');
assertion(copy['zh-CN'].sample==='真实产品界面 · 虚构示例数据','The Chinese fictional-data screenshot caption is missing.');
for(const [html,path] of [[source,'/'],[privacy,'/privacy/']]){
 assertion(html.includes(`<link rel="canonical" href="${origin}${path}">`),`Wrong canonical origin: ${path}`);
 assertion(html.includes(`<meta property="og:url" content="${origin}${path}">`),`Wrong Open Graph origin: ${path}`);
 assertion(html.includes(`<meta name="robots" content="${publicSite?'index,follow':'noindex,nofollow'}">`),`Wrong indexing mode: ${path}`);
 assertion(html.includes("script-src 'self';")&&!html.includes("'unsafe-inline'"),`Structured data must preserve the strict script policy: ${path}`);
}
const notFound=readFileSync('dist/404.html','utf8');
assertion(notFound.includes('<meta name="robots" content="noindex,nofollow">'),'The 404 must not be indexed.');
assertion(!/rel="canonical"|property="og:url"|application\/ld\+json/.test(notFound),'The 404 must not impersonate the homepage or publish its graph.');
const robots=readFileSync('dist/robots.txt','utf8'),sitemap=readFileSync('dist/sitemap.xml','utf8');
assertion(robots.includes(publicSite?'Allow: /':'Disallow: /'),'The robots file disagrees with the indexing mode.');
assertion(!publicSite||robots.includes(`Sitemap: ${origin}/sitemap.xml`),'The public robots file needs the canonical sitemap.');
assertion(sitemap.includes(`<loc>${origin}/</loc>`)&&sitemap.includes(`<loc>${origin}/privacy/</loc>`),'The sitemap needs the canonical public URLs.');
assertion(source.includes('All-in-one<br>GEO tools.'),'The English slogan is missing.');
assertion(privacy.includes('Privacy policy'),'The policy must identify itself clearly.');
assertion(privacy.includes('Google API Services User Data Policy'),'The Google policy link is missing.');
for(const field of ['title','intro','sections','links'])assertion(policy.locales.en[field]&&policy.locales['zh-CN'][field],`Missing policy field: ${field}`);
assertion(JSON.stringify(policy.locales.en.sections.map(s=>s.id))===JSON.stringify(policy.locales['zh-CN'].sections.map(s=>s.id)),'Policy section IDs differ between languages.');
assertion(JSON.stringify(policy.locales.en.links.map(l=>l.href))===JSON.stringify(policy.locales['zh-CN'].links.map(l=>l.href)),'Policy resource links differ between languages.');
assertion(JSON.stringify(Object.keys(copy.en).sort())===JSON.stringify(Object.keys(copy['zh-CN']).sort()),'Website locale keys differ.');
for(const lang of ['en','zh-CN']){
 assertion(tours[lang].length===3,`Three tour views are required: ${lang}`);
 for(const t of tours[lang])assertion(existsSync(join(root,'assets',t.image)),`Screenshot missing: ${t.image}`);
 const contact=policy.locales[lang].links.find(link=>link.id==='contact');
 const support=policy.locales[lang].sections.find(section=>section.id==='retention-support');
 assertion(contact?.href==='mailto:'+siteConfig.contactEmail,`Privacy contact link must use the configured email: ${lang}`);
 assertion(support?.paragraphs.some(text=>text.includes(siteConfig.contactEmail)),`Privacy support text must use the configured email: ${lang}`);
 assertion(!/\{\{[^}]+\}\}/.test(JSON.stringify(policy.locales[lang])),`Privacy content contains an unresolved configuration token: ${lang}`);
}
const schemaTypes=new Set(['WebSite','WebPage','SoftwareApplication','ImageObject','BreadcrumbList','ListItem']);
assertion(policy.locales.en.intro[0].includes('Open-source deployment template'),'The distributed policy must disclose its template status.');
assertion(!existsSync('src/owner.mjs'),'Owner profile data is not part of the distribution.');
const unsupportedClaims=new Set(['offers','price','priceCurrency','aggregateRating','review','downloadUrl','installUrl','sameAs','legalName','address']);
const graphIds={};
const expectedEntityPaths={home:['/#website','/#webpage','/#application','/#screenshot-ai','/#screenshot-search','/#screenshot-keywords'],privacy:['/#website','/privacy/#webpage','/privacy/#breadcrumb']};
const unsupportedReadiness=/(?:Google(?: sign[- ]in)?|GA4)[^.!?。；\n]{0,90}\b(?:ready|verified|approved|certified)\b|\b(?:verified|approved|certified)\s+Google|(?:Google|GA4)[^。；\n]{0,30}(?:正式上线|全面可用|已验证|认证通过)/i;
let structuredGraphs=0,structuredEntities=0;
for(const page of ['home','privacy'])for(const locale of ['en','zh-CN']){
 const document=buildStructuredData({page,locale,origin,copy,tours,policy});
 const graph=document['@graph'],ids=graph.map(entity=>entity['@id']),c=copy[locale];
 const label=`${page} / ${locale}`;
 assertion(document['@context']==='https://schema.org',`Wrong schema context: ${label}`);
 assertion(ids.length===new Set(ids).size,`Duplicate structured-data IDs: ${label}`);
 assertion(JSON.stringify(ids)===JSON.stringify(expectedEntityPaths[page].map(path=>origin+path)),`Established entity identities must remain stable: ${label}`);
 assertion(ids.every(id=>id.startsWith(origin+'/')&&new URL(id).hash),`IDs must use canonical HTTPS URLs and fragments: ${label}`);
 if(locale==='en')graphIds[page]=ids;
 else assertion(JSON.stringify(ids)===JSON.stringify(graphIds[page]),`Language switching must preserve entity identity: ${page}`);
 const visit=value=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(visit);return;}
  if(value['@type'])assertion(schemaTypes.has(value['@type']),`Unexpected entity type ${value['@type']}: ${label}`);
  if(value['@id']&&!value['@type'])assertion(ids.includes(value['@id']),`Unresolved entity reference ${value['@id']}: ${label}`);
  for(const [key,item] of Object.entries(value)){
   assertion(!unsupportedClaims.has(key),`A price, review, download, or unsupported identity claim was added (${key}): ${label}`);
   if(['url','contentUrl','item'].includes(key))assertion(typeof item==='string'&&item.startsWith(origin+'/'),`Non-canonical structured-data URL (${key}): ${label}`);
   visit(item);
  }
 };
 visit(document);
 assertion(!unsupportedReadiness.test(JSON.stringify(document)),`Do not describe Google sign-in or GA4 as ready, verified, approved or certified: ${label}`);
 const browserDocument=browserSchema.buildStructuredData({page,locale,origin,copy:browserContent.copy,tours:browserContent.tours,policy:browserPolicy});
 assertion(JSON.stringify(browserDocument)===JSON.stringify(document),`Built browser modules must reproduce the authored localized graph: ${label}`);
 const byType=type=>graph.filter(entity=>entity['@type']===type);
 const website=byType('WebSite')[0],webpage=byType('WebPage')[0];
 assertion(website.name==='getaudit'&&website.alternateName==='getaudit.si'&&website.url===origin+'/','The website identity must match the approved product and domain.');
 assertion(website.description===c.description&&/SEO\s*\+\s*GEO/.test(website.description),`Website description must reflect the visible SEO + GEO positioning: ${label}`);
 assertion(webpage.inLanguage===locale&&webpage.url===origin+(page==='home'?'/':'/privacy/'),`The page language and URL must match its content: ${label}`);
 if(page==='home'){
  const app=byType('SoftwareApplication')[0],images=byType('ImageObject');
  assertion(app.name==='getaudit'&&app.operatingSystem==='macOS'&&app.applicationCategory==='BusinessApplication','The software identity must describe the actual Mac research app.');
  assertion(app.creativeWorkStatus===c.availability&&/Early access/.test(copy.en.availability),'Do not imply a general public app release.');
  assertion(app.description===c.description&&app.featureList.length===c.jobs.length&&c.jobs.every((job,i)=>app.featureList[i]===job.title+' '+job.body),`Software features must come from the visible copy: ${label}`);
  assertion(webpage.description===c.description&&app.description===website.description,`Homepage, website and app descriptions must agree with current copy: ${label}`);
  assertion(app.disambiguatingDescription===c.heroNote,`App integration status must match the visible hero note: ${label}`);
  assertion(/Google/.test(app.disambiguatingDescription)&&/GA4/.test(app.disambiguatingDescription)&&/testing|测试/.test(app.disambiguatingDescription)&&/Bing Webmaster Tools/.test(app.disambiguatingDescription)&&/planned|规划/.test(app.disambiguatingDescription),`App status must distinguish Google/GA4 testing and planned Bing Webmaster Tools: ${label}`);
  assertion(app.featureList.every(feature=>!/Bing\s+Webmaster(?:\s+Tools)?/i.test(feature)),`Planned Bing Webmaster Tools must not be listed as an available feature: ${label}`);
  assertion(app.featureList.filter(feature=>/Agent/i.test(feature)).every(feature=>!/GA4|full raw|complete original captures|all (?:your )?data|全部数据|完整原始/i.test(feature)),`Agent features must not imply GA4 or full raw capture access: ${label}`);
  assertion(app.inLanguage.includes('en')&&app.inLanguage.includes('zh-CN'),'The app supports English and Simplified Chinese.');
  assertion(images.length===tours[locale].length&&images.every((image,i)=>image.contentUrl===origin+'/assets/'+tours[locale][i].image&&image.caption===c.sample&&image.description===tours[locale][i].alt&&image.inLanguage==='en'),`Screenshots must retain their fictional-data disclosure and actual pixel language: ${label}`);
 }else{
  const breadcrumb=byType('BreadcrumbList')[0],items=breadcrumb.itemListElement;
  assertion(!byType('SoftwareApplication').length,'The privacy page should not repeat the app sales entity.');
  assertion(webpage.description===c.privacyMeta&&webpage.dateModified===policy.effectiveDate,`Privacy metadata must match the displayed policy: ${label}`);
  assertion(items.length===2&&items[0].position===1&&items[0].name===c.home&&items[0].item===origin+'/'&&items[1].position===2&&items[1].name===policy.locales[locale].title&&items[1].item===origin+'/privacy/',`Privacy breadcrumbs must describe the real two-page hierarchy: ${label}`);
 }
 if(locale==='en'){
  const html=page==='home'?source:privacy;
  const blocks=[...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  assertion(blocks.length===1,`Exactly one static JSON-LD graph is required: ${page}`);
  if(blocks.length===1){
   try{assertion(JSON.stringify(JSON.parse(blocks[0][1]))===JSON.stringify(document),`Built structured data is stale or differs from its authored source: ${page}`);}catch{assertion(false,`Invalid JSON-LD: ${page}`);}
  }
  assertion(html.includes(`data-site-origin="${origin}"`),`Language switching must preserve the canonical origin: ${page}`);
  if(page==='home')assertion(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').includes(c.heroNote),'The integration status must be visible outside structured data.');
  assertion(html.includes(c.developerLine),`The developer attribution must be visible: ${page}`);
  if(page==='privacy')assertion(html.includes(`aria-label="${c.breadcrumbs}"`)&&html.includes(`<a href="/">${c.home}</a>`)&&html.includes(`<span aria-current="page">${policy.locales.en.title}</span>`),'Privacy breadcrumbs must also be visible to readers.');
 }
 structuredGraphs++;structuredEntities+=graph.length;
}
const hostileCopy={text:'</script><script>alert("example")</script>',chinese:'中文内容'};
const safeCopy=serializeStructuredData(hostileCopy);
assertion(!safeCopy.includes('<')&&JSON.stringify(JSON.parse(safeCopy))===JSON.stringify(hostileCopy),'JSON-LD serialization must prevent an HTML end-tag injection without changing the data.');
assertion(readFileSync('dist/assets/schema.js','utf8')===readFileSync('src/schema.mjs','utf8'),'The browser and static build must use the same schema builder.');
assertion(readFileSync('dist/assets/site.js','utf8')===readFileSync('src/site.js','utf8'),'The deployed language-switch code is stale.');
let localLinks=0;
for(const page of pages){
 const html=readFileSync(page,'utf8');
 assertion(!/GOCSPX-|ya29\.|Bearer\s+[a-zA-Z0-9]|client_secret\s*[:=]|\/Users\/Mac\/|\/Volumes\/X9/i.test(html),`Private material or filesystem paths: ${page}`);
 assertion(!/\bTODO\b|\bLorem ipsum\b|\[INSERT|\[PLACEHOLDER/i.test(html),`Placeholder content: ${page}`);
 assertion(/<html[^>]+lang="en"/.test(html),`English HTML is required: ${page}`);
 if(!page.includes('sample-report')){
  assertion(!/<form\b|<iframe\b/i.test(html),`Unexpected data collection or embed: ${page}`);
  const remoteSubresources=[...html.matchAll(/<(script|img|link)\b([^>]+)>/gi)].filter(([,tag,attributes])=>/\b(?:src|href)="https?:/i.test(attributes)&&(tag!=='link'||/\brel="(?:stylesheet|preload|icon|modulepreload)"/i.test(attributes)));
  assertion(!remoteSubresources.length,`An external subresource was added: ${page}`);
 }
 for(const [,url]of html.matchAll(/(?:src|href)="([^"]+)"/g)){
  if(/^(https?:|mailto:|data:)/.test(url))continue;
  if(url.startsWith('#')){const id=url.slice(1);if(id)assertion(html.includes(`id="${id}"`),`Broken local anchor: ${url} in ${page}`);continue;}
  const [path,hash]=url.split('#'),clean=path.split('?')[0];
  let target=clean.startsWith('/')?join(root,clean):resolve(dirname(page),clean);
  if(existsSync(target)&&statSync(target).isDirectory())target=join(target,'index.html');
  assertion(existsSync(target),`Missing local target: ${url} in ${page}`);
  if(hash&&existsSync(target)&&target.endsWith('.html'))assertion(readFileSync(target,'utf8').includes(`id="${hash}"`),`Broken cross-page anchor: ${url}`);
  localLinks++;
 }
}
const result={passed:!failures.length,pages:pages.length,localLinks,websiteLocales:2,privacySections:policy.locales.en.sections.length,structuredGraphs,structuredEntities,externalHomepageSubresources:0,public:publicSite,origin,failures};
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exitCode=1;
