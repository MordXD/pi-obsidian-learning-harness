import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
/** Public bibliographic lookup, not a substitute for reading the paper. */
export async function searchSources(query: string, count=4, signal?: AbortSignal, fetcher=fetch) {
  const url=new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic",query);url.searchParams.set("rows",String(Math.min(Math.max(count,1),6)));
  url.searchParams.set("select","DOI,title,author,published,URL,type");
  const response=await fetcher(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{"User-Agent":"Pi-Learning/3 bibliographic-lookup"}});
  if(!response.ok)throw new Error(`Source search HTTP ${response.status}; use a known publisher/university page via web_fetch; do not infer the topic does not exist`);
  const data=await response.json() as any;
  return {kind:"bibliographic_metadata",results:(data.message?.items||[]).slice(0,count).map((x:any)=>({title:x.title?.[0],authors:x.author?.slice(0,3).map((a:any)=>[a.given,a.family].filter(Boolean).join(" ")),year:x.published?.["date-parts"]?.[0]?.[0],doi:x.DOI,url:x.URL})),next:"Open a relevant primary source with web_fetch before citing its substantive claims. Search ranking and metadata do not verify a claim. Empty results do not establish absence of a field."};
}
export default function(pi: ExtensionAPI) {
 pi.registerTool({name:"learning-sources",label:"Учебные источники",description:"Find scholarly bibliographic records through Crossref without API credentials. Prefer for author/title/paper searches or when web_search lacks credentials. Metadata only; open the source before teaching claims.",parameters:Type.Object({query:Type.String({minLength:3,maxLength:400}),count:Type.Optional(Type.Integer({minimum:1,maximum:6}))}),
 async execute(_id,p,signal){try{const value=await searchSources(p.query,p.count,signal);return {content:[{type:"text",text:JSON.stringify(value)}],details:value};}catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}}
 });
}
