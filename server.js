const express=require('express');
const cors=require('cors');
const rag=require('./rag');
const app=express();
const PORT=process.env.PORT||3001;
app.use(cors());
app.use(express.json({limit:'50mb'}));

const ENGINE_PATTERNS=[
  {name:'Avvio',pattern:/\/convert\/site\/([^/"']+)\//g},
  {name:'NewBook',pattern:/newbook\.cloud\/([a-z0-9-]+)\/([a-z0-9-]+)\//g},
  {name:'SynXis',pattern:/[?&]hotel=(\d{3,7})/g},
  {name:'Cloudbeds',pattern:/hotels\.cloudbeds\.com/g},
  {name:'Mews',pattern:/app\.mews\.com|mews\.li/g},
  {name:'SiteMinder',pattern:/thebookingbutton\.com|direct-book\.com/g},
  {name:'RMS',pattern:/rmscloud\.com/g},
];

function extractSignals(text){
  const s={engine:null,engineRaw:[],avvioProperties:[],newbookProperties:[],synxisHotelIds:[],bookingUrls:[],jsonRegistryProperties:[],formSelects:[]};
  for(const eng of ENGINE_PATTERNS){
    const re=new RegExp(eng.pattern.source,'gi');
    const ms=[...text.matchAll(re)];
    if(!ms.length)continue;
    if(!s.engine)s.engine=eng.name;
    s.engineRaw.push({engine:eng.name,count:ms.length});
    if(eng.name==='Avvio')s.avvioProperties.push(...[...new Set(ms.map(m=>decodeURIComponent(m[1]).trim()))]);
    if(eng.name==='NewBook')s.newbookProperties.push(...[...new Map(ms.map(m=>[m[2],{group:m[1],property:m[2]}])).values()]);
    if(eng.name==='SynXis')s.synxisHotelIds.push(...[...new Set(ms.map(m=>m[1]))]);
  }
  const urlRe=/https?:\/\/[^\s"'<>]{8,160}/g;
  s.bookingUrls=[...new Set([...text.matchAll(urlRe)].map(m=>m[0].replace(/['")\]>]+$/,'')).filter(u=>/book|reserv|avail|synxis|newbook|mews/i.test(u)&&!/google|facebook|twitter/i.test(u)))].slice(0,30);
  const vp=text.match(/var\s+properties\s*=\s*(\{[\s\S]{0,900000})/);
  if(vp){try{let depth=0,end=0,seg=vp[1];for(let i=0;i<seg.length;i++){if(seg[i]==='{')depth++;else if(seg[i]==='}'){depth--;if(depth===0){end=i+1;break;}}}const data=JSON.parse(seg.slice(0,end));const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(typeof n!=='object'||!n)return;if(n.title&&n.status)s.jsonRegistryProperties.push({title:String(n.title),status:String(n.status),disable_booking:n.disable_booking||0,booking_link:(n.link||{}).synxis_url||(n.link||{}).external_url||''});Object.values(n).forEach(walk);};walk(data);}catch(_){}}
  const selRe=/<select[^>]+name=["'](hotel|property|resort|park|location)["'][^>]*>([\s\S]*?)<\/select>/gi;
  for(const sel of text.matchAll(selRe)){const opts=[];for(const opt of sel[2].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]+)/gi)){const v=opt[1].trim(),l=opt[2].trim();if(v&&l&&!/select|choose|all/i.test(l))opts.push({value:v,label:l});}if(opts.length)s.formSelects.push({name:sel[1],options:opts});}
  return s;
}

async function crawlSite(targetUrl){
  const logs=[],log=m=>{logs.push(m);console.log('[crawler] '+m);};
  try{
    const parsed=new URL(targetUrl),baseUrl=`${parsed.protocol}//${parsed.hostname}`;
    log('Fetching '+targetUrl);
    const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
    const hdrs={'User-Agent':UA,'Accept':'text/html,application/xhtml+xml,*/*;q=0.8','Accept-Language':'en-GB,en;q=0.9'};
    const pages=[];
    const urlsToFetch=[targetUrl,baseUrl+'/book-now',baseUrl+'/book',baseUrl+'/reservations',baseUrl+'/sitemap.xml'];
    for(const u of urlsToFetch){
      try{const r=await fetch(u,{headers:hdrs,redirect:'follow'});if(r.ok){const h=await r.text();if(h.length>500){pages.push({url:u,html:h});log('Fetched '+u+' ('+h.length+'b)');}}else log('Skip '+u+' '+r.status);}
      catch(e){log('Skip '+u+': '+e.message.slice(0,40));}
    }
    let sitemapUrls=[];
    const sm=pages.find(p=>p.url.includes('sitemap'));
    if(sm){sitemapUrls=[...sm.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1].trim()).filter(u=>!/\.xml$/.test(u)).slice(0,200);log('Sitemap: '+sitemapUrls.length+' URLs');}
    const combined=pages.map(p=>p.html).join('\n');
    const signals=extractSignals(combined);
    log('Engine: '+signals.engine);
    const sitemapProps=sitemapUrls.filter(u=>/(resort|hotel|property|park)s?\/[a-z0-9-]+\/?$/i.test(u)).map(u=>{const m=u.match(/\/([a-z0-9-]+)\/?$/i);return{slug:m?.[1],url:u,source:'sitemap'};});
    return{success:true,url:targetUrl,domain:parsed.hostname,baseUrl,logs,signals,formSelects:signals.formSelects,wpProperties:[],navPropertyLinks:[],sitemapProperties:sitemapProps,sitemapTotalUrls:sitemapUrls.length,sitemapUrls,networkBookingUrls:[],htmlSnapshot:combined.slice(0,80000)};
  }catch(err){log('Error: '+err.message);return{success:false,url:targetUrl,error:err.message,logs};}
}

app.post('/crawl',async(req,res)=>{
  const{url}=req.body;
  if(!url||!url.startsWith('http'))return res.status(400).json({error:'Valid URL required'});
  console.log(`\n[${new Date().toISOString()}] Crawling: ${url}`);
  try{res.json(await crawlSite(url));}catch(err){res.status(500).json({success:false,error:err.message});}
});

app.post('/ingest',async(req,res)=>{
  const{crawlData,registry,voyageKey,qdrantUrl}=req.body;
  if(!crawlData||!registry)return res.status(400).json({error:'crawlData and registry required'});
  if(voyageKey)process.env.VOYAGE_API_KEY=voyageKey;
  if(qdrantUrl)process.env.QDRANT_URL=qdrantUrl;
  const logs=[],log=m=>{logs.push(m);console.log(`[ingest] ${m}`);};
  try{
    const{sitemapUrls=[]}=crawlData,activeProps=registry.active_properties||[];
    const propertyUrls=new Set();
    for(const p of activeProps)if(p.url)propertyUrls.add(p.url);
    const PAGE_RES=[/\/(resort|hotel|property|park)s?\/[a-z0-9-]+\/?$/i,/\/(apartment|room|suite|villa|cabin)s?\/[a-z0-9-]+/i,/\/(offer|deal|promo|special)s?\/[a-z0-9-]+/i];
    for(const u of sitemapUrls){if(propertyUrls.size>=80)break;if(PAGE_RES.some(r=>r.test(u))&&!/\/ar\/|\/zh\//.test(u))propertyUrls.add(u);}
    log(`Fetching ${propertyUrls.size} pages`);
    const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
    const hdrs={'User-Agent':UA,'Accept':'text/html,*/*'};
    const pages=[];
    for(const url of propertyUrls){
      try{const r=await fetch(url,{headers:hdrs});if(r.ok){const html=await r.text();const mp=activeProps.find(p=>p.url&&url.startsWith(p.url.replace(/\/$/,'')));pages.push({url,html,propertyId:mp?mp.name.toLowerCase().replace(/[^a-z0-9]+/g,'_'):null,propertyName:mp?.name||null,confidence:mp?.confidence||'medium'});log(`Fetched ${url.slice(0,60)}`);}else log(`Skip ${url} ${r.status}`);}
      catch(e){log(`Skip ${url}: ${e.message.slice(0,40)}`);}
    }
    log(`Fetched ${pages.length} pages`);
    const summary=await rag.ingestPages(pages,registry,log);
    res.json({success:true,...summary,logs});
  }catch(err){res.status(500).json({success:false,error:err.message,logs});}
});

app.post('/query',async(req,res)=>{
  const{domain,question,filters,topK,voyageKey,qdrantUrl}=req.body;
  if(!domain||!question)return res.status(400).json({error:'domain and question required'});
  if(voyageKey)process.env.VOYAGE_API_KEY=voyageKey;
  if(qdrantUrl)process.env.QDRANT_URL=qdrantUrl;
  try{res.json({success:true,domain,question,chunks:await rag.queryRAG(domain,question,filters||{},topK||6)});}
  catch(err){res.status(500).json({success:false,error:err.message});}
});

app.get('/collection/:domain',async(req,res)=>{
  try{res.json(await rag.collectionStats(req.params.domain));}catch(err){res.status(500).json({error:err.message});}
});

app.delete('/collection/:domain',async(req,res)=>{
  try{await rag.deleteCollection(req.params.domain);res.json({success:true});}catch(err){res.status(500).json({error:err.message});}
});

app.get('/health',(req,res)=>res.json({status:'ok',version:'2.0.0'}));

app.listen(PORT,()=>{
  console.log(`\nGrevon Backend v2 on port ${PORT}`);
  console.log(`Routes: /crawl /ingest /query /collection/:domain /health\n`);
});
