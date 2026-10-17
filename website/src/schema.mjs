// Shared by the static build and language switch; copy stays in its authored catalogs.
export function buildStructuredData({page,locale='en',origin,copy,tours,policy}){
  if(!['home','privacy'].includes(page))return null;
  if(!/^https:\/\/[a-z0-9.-]+$/.test(origin))throw Error('Structured data requires an absolute HTTPS origin without a path.');
  if(!['en','zh-CN'].includes(locale)||!copy[locale])throw Error('Unsupported structured-data language.');
  const c=copy[locale],home=origin+'/',websiteId=home+'#website';
  const website={'@type':'WebSite','@id':websiteId,url:home,name:'getaudit',alternateName:'getaudit.si',description:c.description,inLanguage:['en','zh-CN']};
  const graph=[website];
  if(page==='home'){
    const applicationId=home+'#application';
    const images=tours[locale].map(t=>({'@type':'ImageObject','@id':home+'#screenshot-'+t.id,contentUrl:origin+'/assets/'+t.image,name:t.label,description:t.alt,caption:c.sample,width:1600,height:1200,inLanguage:'en'}));
    graph.push(
      {'@type':'WebPage','@id':home+'#webpage',url:home,name:c.title,description:c.description,inLanguage:locale,isPartOf:{'@id':websiteId},mainEntity:{'@id':applicationId},primaryImageOfPage:{'@id':images[0]['@id']}},
      {'@type':'SoftwareApplication','@id':applicationId,url:home,name:'getaudit',description:c.description,disambiguatingDescription:c.heroNote,applicationCategory:'BusinessApplication',operatingSystem:'macOS',inLanguage:['en','zh-CN'],creativeWorkStatus:c.availability,featureList:c.jobs.map(job=>job.title+' '+job.body),screenshot:images.map(image=>({'@id':image['@id']}))},
      ...images,
    );
  }else{
    const p=policy.locales[locale],url=origin+'/privacy/',breadcrumbId=url+'#breadcrumb';
    graph.push(
      {'@type':'WebPage','@id':url+'#webpage',url,name:p.title+' — getaudit',description:c.privacyMeta,inLanguage:locale,isPartOf:{'@id':websiteId},dateModified:policy.effectiveDate,breadcrumb:{'@id':breadcrumbId}},
      {'@type':'BreadcrumbList','@id':breadcrumbId,itemListElement:[{'@type':'ListItem',position:1,name:c.home,item:home},{'@type':'ListItem',position:2,name:p.title,item:url}]},
    );
  }
  return {'@context':'https://schema.org','@graph':graph};
}

// JSON data blocks still share HTML's script end-tag parsing rules.
export const serializeStructuredData=data=>JSON.stringify(data).replace(/</g,'\\u003c');
