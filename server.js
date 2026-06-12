const express=require('express');
const cors=require('cors');
const{chromium}=require('playwright');
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

async function fetchSitemapUrls(page,baseUrl){
    const urls=[];
    try{
          const robots=await page.evaluate(async u=>{const r=await fetch(u);return r.ok?r.text():'';},`${baseUrl}/robots.txt`);
          const sm=robots.match(/Sitemap:\s*(https?:\/\/\S+)/i);
          const candidates=[sm?sm[1]:null,`${baseUrl}/sitemap_index.xml`,`${baseUrl}/sitemap.xml`,`${baseUrl}/sitemap-0.xml`].filter(Boolean);
          for(const c of candidates){
                  const xml=await page.evaluate(async u=>{try{const r=await fetch(u);return r.ok?r.text():'';}catch{return '';}},c);
                  if(!xml||!xml.includes('<loc>'))continue;
                  const locs=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1].trim());
                  for(const loc of locs){if(loc.endsWith('.xml')){const sub=await page.evaluate(async u=>{try{const r=await fetch(u);return r.ok?r.text():'';}catch{return '';}},loc);urls.push(...[...sub.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1].trim()));}else urls.push(loc);}
                  if(urls.length)break;
          }
    }catch(_){}
    return[...new Set(urls)].filter(u=>!/\/ar\/|\/zh\//i.test(u));
}

async function crawlSite(targetUrl){
    const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});
    const context=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',viewport:{width:1440,height:900},locale:'en-GB'});
    await context.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
    const page=await context.newPage();
    const logs=[],networkUrls=new Set(),allHtml=[];
    page.on('request',req=>{const u=req.url();if(/book|reserv|avail|synxis|newbook|mews|avvio/i.test(u))networkUrls.add(u);});
    const log=m=>{logs.push(m);console.log(`[crawler] ${m}`);};
    try{
          const parsed=new URL(targetUrl),baseUrl=`${parsed.protocol}//${parsed.hostname}`;
          log(`Navigating to ${targetUrl}`);
          await page.goto(targetUrl,{waitUntil:'domcontentloaded',timeout:30000});
          await page.waitForTimeout(2000);
          for(const sel of['#onetrust-accept-btn-handler','button[id*="accept"]','.cc-accept']){try{const b=await page.$(sel);if(b){await b.click();break;}}catch(_){}}
          await page.waitForTimeout(1500);
          allHtml.push(await page.content());
          log(`Homepage: ${allHtml[0].length} bytes`);
          const sitemapUrls=await fetchSitemapUrls(page,baseUrl);
          log(`Sitemap: ${sitemapUrls.length} URLs`);
          for(const path of['/book-now','/book','/reservations']){try{const r=await page.goto(baseUrl+path,{waitUntil:'domcontentloaded',timeout:12000});if(r?.status()===200){await page.waitForTimeout(1500);const h=await page.content();if(h.length>3000){allHtml.push(h);log(`Fetched ${path}`);}}}catch(_){}}
          let wpProps=[];
          try{const wr=await page.evaluate(async b=>{const r=await fetch(`${b}/wp-json/wp/v2/property?per_page=100&_fields=id,link,title,parent`);return r.ok?r.text():'';},baseUrl);if(wr?.startsWith('[')){const d=JSON.parse(wr);wpProps=d.filter(p=>!p.parent).map(p=>({name:(p.title?.rendered||'').replace(/&#\d+;/g,''),url:p.link,source:'wp_rest_api'}));log(`WP REST: ${wpProps.length}`);}}catch(_){}
          await page.goto(targetUrl,{waitUntil:'domcontentloaded',timeout:25000});
          await page.waitForTimeout(1000);
          await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
          await page.waitForTimeout(1500);
          allHtml.push(await page.content());
          const combined=allHtml.join('\n');
          const signals=extractSignals(combined);
          const netSig=extractSignals([...networkUrls].join('\n'));
          if(!signals.engine&&netSig.engine)signals.engine=netSig.engine;
          signals.bookingUrls=[...new Set([...signals.bookingUrls,...netSig.bookingUrls])];
          signals.avvioProperties=[...new Set([...signals.avvioProperties,...netSig.avvioProperties])];
          signals.newbookProperties=[...new Map([...signals.newbookProperties,...netSig.newbookProperties].map(p=>[p.property,p])).values()];
          signals.synxisHotelIds=[...new Set([...signals.synxisHotelIds,...netSig.synxisHotelIds])];
          const sitemapProps=sitemapUrls.filter(u=>/\/(resort|hotel|property|park)s?\/[a-z0-9-]+\/?$/i.test(u)).map(u=>{const m=u.match(/\/(resort|hotel|property|park)s?\/([a-z0-9-]+)\/?$/i);return{slug:m[2],url:u,source:'sitemap'};});
          log('Done');
          return{success:true,url:targetUrl,domain:parsed.hostname,baseUrl,logs,signals,formSelects:signals.formSelects,wpProperties:wpProps,navPropertyLinks:[],sitemapProperties:sitemapProps,sitemapTotalUrls:sitemapUrls.length,sitemapUrls,networkBookingUrls:[...networkUrls].slice(0,30),htmlSnapshot:combined.slice(0,80000)};
    }catch(err){log(`Error: ${err.message}`);return{success:false,url:targetUrl,error:err.message,logs};}
    finally{await browser.close();}
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
          const{baseUrl,sitemapUrls=[]}=crawlData,activeProps=registry.active_properties||[];
          const propertyUrls=new Set();
          for(const p of activeProps)if(p.url)propertyUrls.add(p.url);
          const PAGE_RES=[/\/(resort|hotel|property|park)s?\/[a-z0-9-]+\/?$/i,/\/(apartment|room|suite|villa|cabin)s?\/[a-z0-9-]+/i,/\/(offer|deal|promo|special)s?\/[a-z0-9-]+/i];
          for(const u of sitemapUrls){if(propertyUrls.size>=80)break;if(PAGE_RES.some(r=>r.test(u))&&!/\/ar\/|\/zh\//.test(u))propertyUrls.add(u);}
          log(`Fetching ${propertyUrls.size} pages`);
          const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
          const ctx=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'});
          const pages=[],urlArr=[...propertyUrls];
          for(let i=0;i<urlArr.length;i++){
                  const url=urlArr[i];
                  try{const pg=await ctx.newPage();await pg.goto(url,{waitUntil:'domcontentloaded',timeout:20000});await pg.waitForTimeout(1000);const html=await pg.content();await pg.close();
                              const mp=activeProps.find(p=>p.url&&url.startsWith(p.url.replace(/\/$/,'')));
                              pages.push({url,html,propertyId:mp?mp.name.toLowerCase().replace(/[^a-z0-9]+/g,'_'):null,propertyName:mp?.name||null,confidence:mp?.confidence||'medium'});
                              if((i+1)%5===0)log(`Fetched ${i+1}/${urlArr.length}`);
                     }catch(e){log(`Skip ${url}`);}
          }
          await browser.close();
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
    console.log(`/crawl /ingest /query /collection/:domain /health\n`);
});
