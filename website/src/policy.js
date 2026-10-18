// Safe, shared presentation for static and language-switched privacy content.
const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const paragraphs=items=>(items??[]).map(text=>`<p>${escape(text)}</p>`).join('');
const links=items=>items?.length?`<p class="policy-actions">${items.map(link=>{
  if(!/^https:\/\//.test(link.href))throw Error('Privacy resource links must use HTTPS.');
  return `<a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">${escape(link.label)}</a>`;
}).join('')}</p>`:'';

export function renderPolicyQuickLinks(policy){
  return policy.quickLinks?.length?`<nav class="policy-quick-links" aria-label="${escape(policy.quickLinksLabel)}">${policy.quickLinks.map(link=>`<a href="#${escape(link.id)}">${escape(link.label)}</a>`).join('')}</nav>`:'';
}

export function renderPolicySections(policy){
  return policy.sections.map(section=>`<section id="${escape(section.id)}"><h2>${escape(section.title)}</h2>${paragraphs(section.paragraphs)}${section.scopes?.length?`<dl class="policy-scopes">${section.scopes.map(item=>`<div><dt><code>${escape(item.scope)}</code></dt><dd>${escape(item.purpose)}</dd></div>`).join('')}</dl>`:''}${links(section.links)}${section.steps?.length?`<ol class="policy-steps">${section.steps.map(step=>`<li id="${escape(step.id)}"><h3>${escape(step.title)}</h3>${paragraphs(step.paragraphs)}${links(step.links)}</li>`).join('')}</ol>`:''}</section>`).join('');
}
