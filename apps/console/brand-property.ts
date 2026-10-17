type WebsiteBrand={id:string;owned_domains:string};
function hostname(value:string):string|null {
  try {
    const raw=value.startsWith('sc-domain:')?value.slice(10):value;
    const url=new URL(raw.includes('://')?raw:'https://'+raw);
    if(!['https:','http:'].includes(url.protocol))return null;
    return url.hostname.toLowerCase().replace(/^www\./,'');
  } catch {return null;}
}
/** Match the website owner without changing the original GSC property scope. */
export function brandForProperty<T extends WebsiteBrand>(brands:T[],property:string):T|undefined {
  const host=hostname(property);if(!host)return undefined;
  return brands.find(brand=>{
    try {const domains:unknown=JSON.parse(brand.owned_domains);return Array.isArray(domains)&&domains.some(domain=>typeof domain==='string'&&hostname(domain)===host);}
    catch{return false;}
  });
}

export function preferredBrandProperty(brand:WebsiteBrand):string|undefined {
  try {
    const saved=localStorage.getItem('getaudit.search.property:'+brand.id);
    if(saved&&brandForProperty([brand],saved))return saved;
  }catch{/* Browsing remains available when preferences cannot be read. */}
  try {
    const domains:unknown=JSON.parse(brand.owned_domains);
    const host=Array.isArray(domains)&&typeof domains[0]==='string'?hostname(domains[0]):null;
    return host?'sc-domain:'+host:undefined;
  }catch{return undefined;}
}
