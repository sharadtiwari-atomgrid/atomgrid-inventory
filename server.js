import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { PRODUCT_CATALOGUE } from './server/productCatalogue.js';

const app=express();
app.use(express.json({limit:'10mb'}));
const PORT=process.env.PORT||10000;
const supabaseUrl=process.env.SUPABASE_URL;
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!supabaseUrl||!serviceKey) console.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
const db=createClient(supabaseUrl||'http://localhost',serviceKey||'missing',{auth:{autoRefreshToken:false,persistSession:false}});

const normalize=v=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const coreNormalize=v=>normalize(v)
  .replace(/\b(?:technical|tech|tc|minimum|min)\b/g,' ')
  .replace(/\b(?:pack|packing|bag|bags|drum|drums|carton|cartons|box|boxes|nos|no)\b/g,' ')
  .replace(/\b\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gms|ltr|litre|litres|ml|mt|ton|tons)\b/g,' ')
  .replace(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gms|ltr|litre|litres|ml|mt|ton|tons)?\b/g,' ')
  .replace(/\b(?:min|max)\b/g,' ')
  .replace(/\s+/g,' ').trim();
const editDistance=(a,b)=>{const prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const curr=[i];for(let j=1;j<=b.length;j++)curr[j]=Math.min(curr[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=curr[j]}return prev[b.length]};
const score=(input,p)=>{
  const raw=normalize(input), core=coreNormalize(input);
  const names=[p.name,p.catalogue_name,...(p.aliases||[])].filter(Boolean);
  if(!names.length)return 0;
  return Math.max(...names.map(name=>{
    const x=normalize(name), xc=coreNormalize(name);
    if(raw===x||core===xc)return 1;
    const ed=1-editDistance(raw,x)/Math.max(raw.length,x.length);
    const ced=core&&xc?1-editDistance(core,xc)/Math.max(core.length,xc.length):0;
    const nt=new Set(core.split(' ').filter(Boolean)),xt=new Set(xc.split(' ').filter(Boolean));
    const inter=[...nt].filter(t=>xt.has(t)).length;
    const union=new Set([...nt,...xt]).size;
    const jac=union?inter/union:0;
    const contain=(core.length>5&&(core.includes(xc)||xc.includes(core)))?0.97:0;
    return Math.max(ed,ced,jac>=0.75?0.93+jac*0.05:jac>=0.6?0.90+jac*0.04:0,contain);
  }));
};
const mapProduct=p=>({id:p.id,name:p.name,catalogueName:p.catalogue_name,type:p.type||'Technical',uom:p.uom||'KG',aliases:p.aliases||[],moleculeName:p.molecule_name||'',hsn:p.hsn||'',registrationStatus:p.registration_status||'',isCatalogue:p.is_catalogue!==false});
const getProducts=async()=>{const {data,error}=await db.from('products').select('*').eq('is_catalogue',true).range(0,9999);if(error)throw error;return data||[]};
const ensureSeed=async()=>{
  const rows=PRODUCT_CATALOGUE.map(c=>({catalogue_name:c.catalogueName,name:c.catalogueName,is_catalogue:true,type:c.technicalFormulation||'Technical',uom:'KG',aliases:Array.from(new Set([c.catalogueName,...(c.aliases||[]).filter(Boolean)])),molecule_name:c.moleculeName||'',hsn:c.hsn||'',registration_status:c.registrationStatus||''}));
  if(rows.length){const {error}=await db.from('products').upsert(rows,{onConflict:'catalogue_name'});if(error)throw error}
  const {data:w,error:we}=await db.from('warehouses').select('*').range(0,99);if(we)throw we;
  if(!(w||[]).length){const {error}=await db.from('warehouses').insert([{name:'AG Warehouse (Panoli)'},{name:'Bhatinda Warehouse'}]);if(error)throw error}
};
const resolveProduct=async(source,name,products,mappings)=>{
  const n=normalize(name);
  const manual=(mappings||[]).find(m=>m.source===source&&m.normalized_source_name===n);
  if(manual)return {id:manual.product_id,confidence:1,status:'MANUAL'};
  const ranked=products.map(p=>({p,s:score(name,p)})).sort((a,b)=>b.s-a.s);
  const best=ranked[0], second=ranked[1];
  if(!best||best.s<0.86||(second&&best.s<0.93&&best.s-second.s<0.02))return {id:null,confidence:best?.s||0,status:'UNMAPPED',candidates:ranked.slice(0,5)};
  return {id:best.p.id,confidence:best.s,status:'AUTO'};
};

app.get('/api/inventory',async(req,res)=>{try{await ensureSeed();const [p,w]=await Promise.all([getProducts(),db.from('warehouses').select('*').range(0,99)]);if(w.error)throw w.error;res.json({products:p.map(mapProduct),warehouses:w.data||[]})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/mappings',async(req,res)=>{try{const {data,error}=await db.from('product_mappings').select('*').range(0,9999);if(error)throw error;res.json({mappings:data||[]})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/mappings/resolve',async(req,res)=>{try{const source=String(req.body.source||'').trim(),sourceName=String(req.body.sourceName||'').trim();if(!source||!sourceName)return res.status(400).json({error:'Source and source product name are required.'});await ensureSeed();const products=await getProducts();const {data:mappings,error}=await db.from('product_mappings').select('*').range(0,9999);if(error)throw error;const r=await resolveProduct(source,sourceName,products,mappings);const candidates=products.map(p=>({product:mapProduct(p),score:score(sourceName,p)})).sort((a,b)=>b.score-a.score).slice(0,5);res.json({ok:Boolean(r.id),status:r.status,product:r.id?mapProduct(products.find(p=>p.id===r.id)):null,score:r.confidence,candidates})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/mappings',async(req,res)=>{try{const source=String(req.body.source||'').trim(),sourceName=String(req.body.sourceName||'').trim(),productId=String(req.body.productId||'').trim();if(!source||!sourceName||!productId)return res.status(400).json({error:'Source, source name and product are required.'});const products=await getProducts();if(!products.some(p=>p.id===productId))return res.status(404).json({error:'Product not found.'});const normalizedSourceName=normalize(sourceName);const {data,error}=await db.from('product_mappings').upsert({source,source_name:sourceName,normalized_source_name:normalizedSourceName,product_id:productId,confidence:1,status:'MANUAL'},{onConflict:'source,normalized_source_name'}).select().single();if(error)throw error;res.json({ok:true,id:data.id})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/catalogue/import',async(req,res)=>{
  try{
    const rows=Array.isArray(req.body.rows)?req.body.rows:[];
    if(!rows.length)return res.status(400).json({error:'Catalogue rows are required.'});
    await ensureSeed();
    const records=rows.map(r=>{
      const catalogueName=String(r.catalogueName||'').trim();
      if(!catalogueName)return null;
      const aliases=Array.isArray(r.aliases)?r.aliases.map(String):[];
      return {
        catalogue_name:catalogueName,
        name:catalogueName,
        is_catalogue:true,
        type:String(r.technicalFormulation||'Technical'),
        uom:String(r.uom||'KG').toUpperCase(),
        aliases:Array.from(new Set([catalogueName,...aliases])),
        molecule_name:String(r.moleculeName||''),
        hsn:String(r.hsn||''),
        registration_status:String(r.registrationStatus||'')
      };
    }).filter(Boolean);
    if(records.length){
      const {error}=await db.from('products').upsert(records,{onConflict:'catalogue_name'});
      if(error)throw error;
    }
    res.json({ok:true,updated:records.length,added:0,total:rows.length});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/source-import',async(req,res)=>{try{const source=String(req.body.source||'').trim(),reportDate=String(req.body.reportDate||'').trim(),rows=Array.isArray(req.body.rows)?req.body.rows:[];console.log('[source-import]',source,reportDate,'rows=',rows.length);if(!source||!reportDate||!rows.length)return res.status(400).json({error:'Source, report date and rows are required.'});const del=await db.from('source_records').delete().eq('source',source).eq('report_date',reportDate);if(del.error)throw del.error;const records=rows.map(r=>({source,report_date:reportDate,movement_date:r.movementDate?String(r.movementDate):null,product_name:String(r.productName||'').trim(),quantity:Number(r.quantity||0),direction:r.direction?String(r.direction):null,warehouse_inward:Number(r.warehouseInward||0),warehouse_outward:Number(r.warehouseOutward||0),warehouse_stock:r.warehouseStock===''||r.warehouseStock==null?null:Number(r.warehouseStock)})).filter(r=>r.product_name&&(r.quantity>0||source==='Warehouse Report'));console.log('[source-import] prepared=',records.length,'sample=',JSON.stringify(records[0]||{}));let inserted=0;for(let i=0;i<records.length;i+=500){const {data,error}=await db.from('source_records').insert(records.slice(i,i+500)).select('id');if(error)throw error;inserted+=(data||[]).length}res.json({ok:true,source,reportDate,inserted})}catch(e){console.error('[source-import] failed',e);res.status(500).json({error:e?.message||String(e)})}});
app.get('/api/reconciliation',async(req,res)=>{try{const date=String(req.query.date||'').slice(0,10);if(!date)return res.status(400).json({error:'Date is required.'});await ensureSeed();const [products,mr,rr]=await Promise.all([getProducts(),db.from('product_mappings').select('*').range(0,9999),db.from('source_records').select('*').range(0,9999)]);if(mr.error)throw mr.error;if(rr.error)throw rr.error;const mappings=mr.data||[],recs=rr.data||[],resolutionCache=new Map();const resolveCached=async(source,name)=>{const k=source+'|'+normalize(name);if(!resolutionCache.has(k))resolutionCache.set(k,resolveProduct(source,name,products,mappings));return resolutionCache.get(k)};const inward=new Map(),outward=new Map(),dailyInward=new Map(),dailyOutward=new Map(),wh=new Map(),names=new Map();
  for(const r of recs){if(r.source==='Domestic MIS'&&r.direction==='INWARD'&&r.movement_date&&r.movement_date<=date){const m=await resolveCached('Domestic MIS',r.product_name);const key=m.id||'UNMAPPED:'+normalize(r.product_name);inward.set(key,(inward.get(key)||0)+Number(r.quantity||0));if(r.movement_date===date)dailyInward.set(key,(dailyInward.get(key)||0)+Number(r.quantity||0));names.set(key,r.product_name)}
    if(r.source==='Outward Dispatch Sheet'&&r.direction==='OUTWARD'&&r.movement_date&&r.movement_date<=date){const m=await resolveCached('Outward Dispatch Sheet',r.product_name);const key=m.id||'UNMAPPED:'+normalize(r.product_name);outward.set(key,(outward.get(key)||0)+Number(r.quantity||0));if(r.movement_date===date)dailyOutward.set(key,(dailyOutward.get(key)||0)+Number(r.quantity||0));names.set(key,r.product_name)}
    if(r.source==='Warehouse Report'&&r.report_date===date){const m=await resolveCached('Warehouse Report',r.product_name);const key=m.id||'UNMAPPED:'+normalize(r.product_name);const prev=wh.get(key);const stock=r.warehouse_stock==null?null:Number(r.warehouse_stock);wh.set(key,{inward:(prev?.inward||0)+Number(r.warehouse_inward||0),outward:(prev?.outward||0)+Number(r.warehouse_outward||0),stock:stock==null?(prev?.stock??null):stock});names.set(key,r.product_name)}}
  const keys=new Set([...inward.keys(),...outward.keys(),...wh.keys()]);const rows=Array.from(keys).map(key=>{const p=products.find(x=>x.id===key);const ourInward=inward.get(key)||0,ourOutward=outward.get(key)||0,ourClosing=ourInward-ourOutward,w=wh.get(key),warehouseClosing=w?.stock??null,variance=warehouseClosing==null?null:ourClosing-warehouseClosing;const status=!p?'UNMAPPED':warehouseClosing==null?'PENDING VERIFICATION':Math.abs(variance||0)<0.001?'MATCH':'VARIANCE';return{productId:p?.id||null,product:p?.catalogue_name||p?.name||names.get(key)||key.replace('UNMAPPED:',''),sourceProductName:names.get(key)||null,ourInward,ourOutward,ourClosing,todayInward:dailyInward.get(key)||0,todayOutward:dailyOutward.get(key)||0,warehouseInward:w?.inward||0,warehouseOutward:w?.outward||0,warehouseClosing,variance,status}}).sort((a,b)=>Math.abs(b.variance||0)-Math.abs(a.variance||0));const summary={productsChecked:rows.length,matched:rows.filter(r=>r.status==='MATCH').length,variance:rows.filter(r=>r.status==='VARIANCE').length,pending:rows.filter(r=>r.status==='PENDING VERIFICATION').length,unmapped:rows.filter(r=>r.status==='UNMAPPED').length,positiveVariance:rows.filter(r=>(r.variance||0)>0).reduce((s,r)=>s+r.variance,0),negativeVariance:rows.filter(r=>(r.variance||0)<0).reduce((s,r)=>s+r.variance,0)};res.json({date,summary,rows})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/products',async(req,res)=>{try{const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({error:'Product name is required.'});await ensureSeed();const products=await getProducts();const ranked=products.map(p=>({p,s:score(name,p)})).sort((a,b)=>b.s-a.s);if(ranked[0]&&ranked[0].s>=0.9)return res.status(409).json({ok:false,duplicate:true,error:'This matches existing catalogue product: '+ranked[0].p.catalogue_name});const record={name,catalogue_name:String(req.body.catalogueName||name),is_catalogue:true,type:String(req.body.type||'Technical'),uom:String(req.body.uom||'KG'),aliases:[],molecule_name:'',hsn:'',registration_status:''};const {data,error}=await db.from('products').insert(record).select().single();if(error)throw error;res.json({ok:true,id:data.id})}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/health',(req,res)=>res.json({ok:true,service:'atomgrid-inventory'}));
app.use(express.static('dist'));
app.use((req,res)=>res.sendFile(process.cwd()+'/dist/index.html'));
app.listen(PORT,()=>console.log('Atomgrid Inventory listening on '+PORT));
