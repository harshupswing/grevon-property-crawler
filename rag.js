const{QdrantClient}=require('@qdrant/js-client-rest');
const VOYAGE_MODEL='voyage-3-lite',EMBED_DIM=512,CHUNK_SIZE=400,CHUNK_OVERLAP=60;
function getQdrant(){return new QdrantClient({url:process.env.QDRANT_URL||'http://localhost:6333'});}
function collectionName(d){return 'grevon_'+d.replace(/[^a-z0-9]/gi,'_').toLowerCase();}
function cleanHtml(h){return h.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim();}
function chunkPage({url,html,propertyId,propertyName,confidence}){
    const chunks=[],title=(html.match(/<title>([^<]+)/i)||[])[1]||url;
    const body=cleanHtml(html),words=body.split(/\s+/);
    for(let i=0;i<words.length;i+=CHUNK_SIZE-CHUNK_OVERLAP){
          const text=words.slice(i,i+CHUNK_SIZE).join(' ');
          if(text.split(/\s+/).length<20)continue;
          chunks.push({text:`[${propertyName||'Group'}] ${title}\n\n${text}`,metadata:{url,property_id:propertyId||'corporate',property_name:propertyName||'Group',page_type:'content',confidence:confidence||'medium'}});
    }
    return chunks;
}
function buildMetaChunks(registry){
    const chunks=[],props=registry.active_properties||[],q=registry.quarantine||[];
    chunks.push({text:`${registry.domain} Portfolio\nTotal: ${props.length}\nEngine: ${registry.booking_engine||'unknown'}\n${props.map(p=>`- ${p.name} (${p.confidence})`).join('\n')}`,metadata:{url:`https://${registry.domain}/`,property_id:'portfolio',property_name:'Portfolio',page_type:'booking_metadata',confidence:'high'}});
    for(const p of props)chunks.push({text:`Property: ${p.name}\nStatus: ACTIVE\nCode: ${p.booking_code||'n/a'}\nEngine: ${registry.booking_engine}\nURL: ${p.url||''}\nLocation: ${p.location||''}`,metadata:{url:p.url||`https://${registry.domain}/`,property_id:p.name.toLowerCase().replace(/[^a-z0-9]+/g,'_'),property_name:p.name,page_type:'booking_metadata',confidence:p.confidence}});
    if(q.length)chunks.push({text:`Quarantined (NOT bookable):\n${q.map(x=>`- ${x.name}: ${x.reason}`).join('\n')}`,metadata:{url:`https://${registry.domain}/`,property_id:'quarantine',property_name:'Quarantine',page_type:'booking_metadata',confidence:'high'}});
    return chunks;
}
async function embed(texts,type='document'){
    const key=process.env.VOYAGE_API_KEY;if(!key)throw new Error('VOYAGE_API_KEY not set');
    const r=await fetch('https://api.voyageai.com/v1/embeddings',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:VOYAGE_MODEL,input:texts,input_type:type})});
    if(!r.ok)throw new Error(`Voyage ${r.status}`);
    return(await r.json()).data.map(d=>d.embedding);
}
async function ensureCollection(client,name){try{await client.getCollection(name);}catch(_){await client.createCollection(name,{vectors:{size:EMBED_DIM,distance:'Cosine'}});}}
async function ingestPages(pages,registry,log=console.log){
    const coll=collectionName(registry.domain),client=getQdrant();
    await ensureCollection(client,coll);
    const chunks=[...pages.flatMap(p=>chunkPage(p)),...buildMetaChunks(registry)];
    log(`[rag] ${chunks.length} chunks`);
    const embeddings=[];
    for(let i=0;i<chunks.length;i+=96){log(`[rag] embedding ${i+1}-${Math.min(i+96,chunks.length)}`);embeddings.push(...await embed(chunks.slice(i,i+96).map(c=>c.text)));if(i+96<chunks.length)await new Promise(r=>setTimeout(r,300));}
    const points=chunks.map((c,i)=>({id:Math.floor(Math.random()*1e15),vector:embeddings[i],payload:{text:c.text,...c.metadata}}));
    for(let i=0;i<points.length;i+=100)await client.upsert(coll,{wait:true,points:points.slice(i,i+100)});
    log(`[rag] done: ${points.length} vectors`);
    return{collection:coll,domain:registry.domain,chunks_total:chunks.length,pages_processed:pages.length};
}
async function queryRAG(domain,question,filters={},topK=6){
    const client=getQdrant(),coll=collectionName(domain),vector=(await embed([question],'query'))[0];
    const p={vector,limit:topK,with_payload:true};
    if(Object.keys(filters).length)p.filter={must:Object.entries(filters).map(([k,v])=>({key:k,match:{value:v}}))};
    return(await client.search(coll,p)).map(r=>({score:r.score,text:r.payload.text,url:r.payload.url,property_id:r.payload.property_id,property_name:r.payload.property_name,page_type:r.payload.page_type,confidence:r.payload.confidence}));
}
async function collectionStats(domain){try{const i=await getQdrant().getCollection(collectionName(domain));return{exists:true,collection:collectionName(domain),vectors:i.vectors_count};}catch(_){return{exists:false,collection:collectionName(domain)};}}
async function deleteCollection(domain){await getQdrant().deleteCollection(collectionName(domain));}
module.exports={ingestPages,queryRAG,collectionStats,deleteCollection,collectionName,EMBED_DIM};
