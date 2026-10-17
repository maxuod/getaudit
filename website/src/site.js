import {siteConfig} from './config.mjs';
import {copy,tours} from './content.js';
import {buildStructuredData,serializeStructuredData} from './schema.js';

const allowed=['en','zh-CN'];
const pref='getaudit.website.language';
let locale='en',selectedTour=0,policyData;
try{const saved=localStorage.getItem(pref);if(allowed.includes(saved))locale=saved;}catch{/* The site remains usable with browser storage disabled. */}
const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const page=document.body.dataset.page;
const c=()=>copy[locale];

function renderTour(){
  if(!document.querySelector('[data-tour]'))return;
  const t=tours[locale][selectedTour];
  document.querySelector('[data-tour-title]').textContent=t.title;
  document.querySelector('[data-tour-body]').textContent=t.body;
  const image=document.querySelector('[data-tour-image]');
  image.src='/assets/'+t.image;image.alt=t.alt;
  document.querySelectorAll('[data-tour-index]').forEach((button,i)=>{
    const active=i===selectedTour;button.textContent=tours[locale][i].label;
    button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
  });
  document.getElementById('tour-panel').setAttribute('aria-labelledby','tab-'+t.id);
  document.querySelector('[role="tablist"]').setAttribute('aria-label',c().tourAria);
}

function renderPolicy(){
  if(page!=='privacy'||!policyData)return;
  const p=policyData.locales[locale];
  const block=document.querySelector('[data-policy]');
  block.innerHTML=`<div class="policy-title"><nav class="back-link" aria-label="${escape(c().breadcrumbs)}"><a href="/">${escape(c().home)}</a><span aria-hidden="true"> / </span><span aria-current="page">${escape(p.title)}</span></nav><h1>${escape(p.title)}</h1><p class="policy-date">${escape(c().policyDate)}: <time datetime="${policyData.effectiveDate}">${policyData.effectiveDate}</time></p>${p.intro.map(x=>`<p>${escape(x)}</p>`).join('')}</div><div class="policy-layout"><aside class="policy-contents"><span>${escape(c().policyContents)}</span><nav aria-label="${escape(c().policyContents)}">${p.sections.map(s=>`<a href="#${escape(s.id)}">${escape(s.title)}</a>`).join('')}</nav></aside><article class="policy-article"><div class="policy-summary"><h2>${escape(c().policySummary)}</h2><p>${escape(c().policyQuick)}</p></div>${p.sections.map(s=>`<section id="${escape(s.id)}"><h2>${escape(s.title)}</h2>${s.paragraphs.map(x=>`<p>${escape(x)}</p>`).join('')}</section>`).join('')}<section class="policy-links"><h2>${locale==='en'?'Related resources':'相关链接'}</h2><ul>${p.links.map(l=>`<li><a href="${escape(l.href)}" rel="noopener noreferrer" target="_blank">${escape(l.label)}</a></li>`).join('')}</ul></section><section class="policy-contact"><h2>${escape(c().policyContact)}</h2><p>${escape(c().policyContactBody)}</p><a href="mailto:${escape(siteConfig.contactEmail)}">${escape(siteConfig.contactEmail)}</a></section></article></div>`;
}

function render(){
  const text=c();document.documentElement.lang=locale;
  document.querySelectorAll('[data-t]').forEach(element=>{const value=text[element.dataset.t];if(typeof value==='string')element.textContent=value;});
  document.querySelectorAll('[data-h]').forEach(element=>{const value=text[element.dataset.h];if(typeof value==='string')element.innerHTML=value;});
  document.querySelectorAll('[data-step-title]').forEach(el=>{el.textContent=text.steps[Number(el.dataset.stepTitle)].title;});
  document.querySelectorAll('[data-step-body]').forEach(el=>{el.textContent=text.steps[Number(el.dataset.stepBody)].body;});
  document.querySelectorAll('[data-job-title]').forEach(el=>{el.textContent=text.jobs[Number(el.dataset.jobTitle)].title;});
  document.querySelectorAll('[data-job-body]').forEach(el=>{el.textContent=text.jobs[Number(el.dataset.jobBody)].body;});
  document.querySelectorAll('[data-faq-q]').forEach(el=>{el.textContent=text.faqs[Number(el.dataset.faqQ)].q;});
  document.querySelectorAll('[data-faq-a]').forEach(el=>{el.textContent=text.faqs[Number(el.dataset.faqA)].a;});
  document.querySelectorAll('[data-language]').forEach(button=>{button.setAttribute('aria-label',text.language);button.title=text.language;});
  document.querySelectorAll('[data-zoom]').forEach(button=>{button.setAttribute('aria-label',text.zoom);button.title=text.zoom;});
  document.querySelector('.screenshot-dialog')?.setAttribute('aria-label',text.screenshot);
  const closeButton=document.querySelector('[data-dialog-close]');if(closeButton)closeButton.textContent=text.close;
  document.querySelector('.menu-button')?.setAttribute('aria-label',text.menu);
  document.querySelectorAll('.brand').forEach(a=>a.setAttribute('aria-label',locale==='en'?'getaudit home':'getaudit 主页'));
  document.querySelector('.desktop-nav')?.setAttribute('aria-label',locale==='en'?'Main navigation':'主导航');
  document.querySelector('.mobile-nav')?.setAttribute('aria-label',locale==='en'?'Mobile navigation':'移动导航');
  const reportLabel=document.querySelector('[data-report-label]');if(reportLabel)reportLabel.textContent=locale==='en'?'Explore the product views':'看看产品界面';
  document.title=page==='privacy'?(locale==='en'?'Privacy policy template — getaudit':'隐私政策模板 — getaudit'):page==='not-found'?text.notFoundMeta:text.title;
  const description=page==='privacy'?text.privacyMeta:text.description;
  document.querySelector('meta[name="description"]')?.setAttribute('content',description);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content',document.title);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content',description);
  renderTour();renderPolicy();
  const schemaElement=document.querySelector('[data-structured-data]');
  if(schemaElement&&(page!=='privacy'||policyData)){
    schemaElement.textContent=serializeStructuredData(buildStructuredData({page,locale,origin:schemaElement.dataset.siteOrigin,copy,tours,policy:policyData}));
  }
}

document.querySelectorAll('[data-language]').forEach(button=>button.addEventListener('click',()=>{
  const scroll=window.scrollY;locale=locale==='en'?'zh-CN':'en';
  try{localStorage.setItem(pref,locale);}catch{/* A preference is optional. */}
  render();window.scrollTo({top:scroll,behavior:'instant'});
}));

document.querySelectorAll('[data-tour-index]').forEach(button=>{
  button.addEventListener('click',()=>{selectedTour=Number(button.dataset.tourIndex);renderTour();});
  button.addEventListener('keydown',event=>{
    let next=selectedTour;
    if(event.key==='ArrowRight')next=(selectedTour+1)%tours.en.length;
    else if(event.key==='ArrowLeft')next=(selectedTour+tours.en.length-1)%tours.en.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=tours.en.length-1;
    else return;
    event.preventDefault();selectedTour=next;renderTour();document.querySelector(`[data-tour-index="${next}"]`).focus();
  });
});

const dialog=document.querySelector('.screenshot-dialog');
document.querySelectorAll('[data-zoom]').forEach(button=>button.addEventListener('click',()=>{
  const t=tours[locale][selectedTour],image=document.querySelector('[data-dialog-image]');image.src='/assets/'+t.image;image.alt=t.alt;dialog.showModal();
}));
document.querySelector('[data-dialog-close]')?.addEventListener('click',()=>dialog.close());
dialog?.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}});
const menu=document.querySelector('.menu-button'),mobileNav=document.getElementById('mobile-nav');
menu?.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));mobileNav.hidden=!open;});
mobileNav?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{mobileNav.hidden=true;menu.setAttribute('aria-expanded','false');}));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu?.getAttribute('aria-expanded')==='true'){mobileNav.hidden=true;menu.setAttribute('aria-expanded','false');menu.focus();}});

if(page==='privacy'){
  try{policyData=(await import('./privacy-content.js')).policy;}catch{/* The complete English policy is already rendered in HTML. */}
}
render();
