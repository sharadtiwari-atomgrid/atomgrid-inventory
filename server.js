import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app=express();
app.use(express.json({limit:'20mb'}));
const PORT=process.env.PORT||10000;
const db=createClient(process.env.SUPABASE_URL||'http://localhost',process.env.SUPABASE_SERVICE_ROLE_KEY||'missing',{auth:{autoRefreshToken:false,persistSession:false}});

const normalize=v=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const core=v=>normalize(v)
 .replace(/\b(?:technical|tech|tc|min|minimum)\b/g,' ')
 .replace(/\b(?:pack|packing|bag|bags|drum|drums|carton|cartons|box|boxes|nos|no)\b/g,' ')
 .replace(/\b\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gms|ltr|litre|litres|ml|mt|ton|tons)\b/g,' ')
 .replace(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gms|ltr|litre|litres|ml|mt|ton|tons)?\b/g,' ')
 .replace(/\s+/g,' ').trim();
const editDistance=(a,b)=>{const prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const cur=[i];for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=cur[j]}return prev[b.length]};
const productScore=(input,p)=>{
 const raw=normalize(input), c=core(input);
 const names=[p.catalogue_name,...(Array.isArray(p.aliases)?p.aliases:[])].filter(Boolean);
 return Math.max(0,...names.map(n=>{
   const x=normalize(n), xc=core(n);
   if(raw===x||c===xc)return 1;
   const ed=1-editDistance(raw,x)/Math.max(raw.length,x.length);
   const ced=c&&xc?1-editDistance(c,xc)/Math.max(c.length,xc.length):0;
   const a=new Set(c.split(' ').filter(Boolean)), b=new Set(xc.split(' ').filter(Boolean));
   const union=new Set([...a,...b]).size, inter=[...a].filter(t=>b.has(t)).length;
   const jac=union?inter/union:0;
   return Math.max(ed,ced,jac>=.72?.94:jac>=.58?.88:jac);
 }));
};
const getProducts=async()=>{const {data,error}=await db.from('inventory_products').select('*').range(0,9999);if(error)throw error;return data||[]};
const resolve=(name,products)=>{
 const ranked=products.map(p=>({p,s:productScore(name,p)})).sort((a,b)=>b.s-a.s);
 const best=ranked[0], second=ranked[1];
 if(!best||best.s<0.86||(second&&best.s<0.94&&best.s-second.s<0.025))return {id:null,score:best?.s||0};
 return {id:best.p.id,score:best.s};
};

app.get('/api/health',(req,res)=>res.json({ok:true,model:'inventory-v2'}));
app.get('/api/products',async(req,res)=>{try{res.json({products:await getProducts()})}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/import/products',async(req,res)=>{
 try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  if(!rows.length)throw new Error('No catalogue rows supplied.');
  const grouped=new Map();
  for(const r of rows){
   const cat=String(r.catalogueName||'').trim(); if(!cat)continue;
   const x=grouped.get(cat)||{catalogue_name:cat,aliases:new Set(),molecule_name:String(r.moleculeName||''),hsn:String(r.hsn||''),registration_status:String(r.registrationStatus||''),uom:'KG'};
   x.aliases.add(cat); if(r.productName)x.aliases.add(String(r.productName).trim()); grouped.set(cat,x);
  }
  const records=[...grouped.values()].map(x=>({...x,aliases:[...x.aliases]}));
  const {error}=await db.from('inventory_products').upsert(records,{onConflict:'catalogue_name'});
  if(error)throw error;
  res.json({ok:true,products:records.length});
 }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/import/base-stock',async(req,res)=>{
 try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  const products=await getProducts();
  const records=[]; const errors=[];
  for(const r of rows){
   const name=String(r.productName||'').trim(), date=String(r.baseDate||'').slice(0,10), qty=Number(r.baseQuantity||0);
   if(!name||!date)continue;
   const m=resolve(name,products);
   if(!m.id){errors.push({productName:name,score:m.score});continue}
   records.push({product_id:m.id,base_date:date,base_quantity:qty});
  }
  if(errors.length) return res.status(400).json({error:'Some base-stock products could not be matched.',unmapped:errors.slice(0,30)});
  if(records.length){const {error}=await db.from('inventory_base_stock').upsert(records,{onConflict:'product_id'});if(error)throw error}
  res.json({ok:true,updated:records.length});
 }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/import/domestic',async(req,res)=>{
 try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  const products=await getProducts(); if(!products.length)throw new Error('Import Product Catalogue first.');
  const records=[];
  for(const r of rows){
   if(!r.actualDate||!r.productName||!(Number(r.quantity)>0))continue;
   const m=resolve(r.productName,products);
   records.push({
    source_key:String(r.sourceKey),
    product_id:m.id,
    source_product_name:String(r.productName).trim(),
    movement_type:r.movementType,
    actual_date:String(r.actualDate).slice(0,10),
    quantity:Number(r.quantity),
    job_no:String(r.jobNo||''),
    status:String(r.status||''),
    origin_type:String(r.originType||''),
    destination_type:String(r.destinationType||'')
   });
  }
  if(!records.length)throw new Error('No valid Domestic MIS movements found.');
  const {error}=await db.from('inventory_domestic_movements').upsert(records,{onConflict:'source_key'});
  if(error)throw error;
  res.json({ok:true,inserted:records.length,unmapped:records.filter(x=>!x.product_id).length});
 }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/import/warehouse',async(req,res)=>{
 try{
  const movements=Array.isArray(req.body.movements)?req.body.movements:[], eod=Array.isArray(req.body.eod)?req.body.eod:[];
  const products=await getProducts(); if(!products.length)throw new Error('Import Product Catalogue first.');
  const wm=movements.filter(r=>r.movementDate&&r.productName&&Number(r.quantity)>0).map(r=>{const m=resolve(r.productName,products);return{
    source_key:String(r.sourceKey),product_id:m.id,source_product_name:String(r.productName).trim(),movement_type:r.movementType,movement_date:String(r.movementDate).slice(0,10),quantity:Number(r.quantity),reference_no:String(r.referenceNo||'')
  }});
  if(wm.length){const {error}=await db.from('inventory_warehouse_movements').upsert(wm,{onConflict:'source_key'});if(error)throw error}
  const snapshots=[...new Set(eod.map(x=>String(x.snapshotDate).slice(0,10)).filter(Boolean))];
  for(const d of snapshots){const del=await db.from('inventory_warehouse_eod').delete().eq('snapshot_date',d);if(del.error)throw del.error}
  const groupedEod=new Map();
  for(const r of eod.filter(r=>r.snapshotDate&&r.productName)){
    const m=resolve(r.productName,products); if(!m.id)continue;
    const k=String(r.snapshotDate).slice(0,10)+'|'+m.id;
    const prev=groupedEod.get(k); const q=r.physicalClosingStock==null?null:Number(r.physicalClosingStock);
    groupedEod.set(k,{snapshot_date:String(r.snapshotDate).slice(0,10),product_id:m.id,source_product_name:String(r.productName).trim(),physical_closing_stock:(prev?.physical_closing_stock||0)+(q==null?0:q)});
  }
  const we=[...groupedEod.values()];
  if(we.length){const {error}=await db.from('inventory_warehouse_eod').insert(we);if(error)throw error}
  res.json({ok:true,movements:wm.length,eod:we.length,unmappedMovements:wm.filter(x=>!x.product_id).length,snapshotDates:snapshots});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/reconciliation',async(req,res)=>{
 try{
  const date=String(req.query.date||'').slice(0,10); if(!date)throw new Error('Date is required.');
  const [products,base,dm,wm,eod]=await Promise.all([
   getProducts(),
   db.from('inventory_base_stock').select('*').range(0,9999),
   db.from('inventory_domestic_movements').select('*').lte('actual_date',date).range(0,9999),
   db.from('inventory_warehouse_movements').select('*').eq('movement_date',date).range(0,9999),
   db.from('inventory_warehouse_eod').select('*').eq('snapshot_date',date).range(0,9999)
  ]);
  for(const x of [base,dm,wm,eod])if(x.error)throw x.error;
  const baseMap=new Map((base.data||[]).map(x=>[x.product_id,x]));
  const di=new Map(),do_=new Map(),todayDi=new Map(),todayDo=new Map(),wi=new Map(),wo=new Map(),physical=new Map();
  for(const r of dm.data||[]){if(!r.product_id)continue;const b=baseMap.get(r.product_id);if(!b||r.actual_date<b.base_date)continue;const q=Number(r.quantity||0);const map=r.movement_type==='INWARD'?di:do_;map.set(r.product_id,(map.get(r.product_id)||0)+q);if(r.actual_date===date){const dm=r.movement_type==='INWARD'?todayDi:todayDo;dm.set(r.product_id,(dm.get(r.product_id)||0)+q)}}
  for(const r of wm.data||[]){if(!r.product_id)continue;const map=r.movement_type==='INWARD'?wi:wo;map.set(r.product_id,(map.get(r.product_id)||0)+Number(r.quantity||0))}
  for(const r of eod.data||[])if(r.product_id)physical.set(r.product_id,r.physical_closing_stock==null?null:Number(r.physical_closing_stock));
  const rows=products.map(p=>{
    const b=baseMap.get(p.id), baseQty=b&&b.base_date<=date?Number(b.base_quantity||0):null;
    const inward=di.get(p.id)||0,outward=do_.get(p.id)||0;
    const expected=baseQty==null?null:baseQty+inward-outward;
    const wh=physical.has(p.id)?physical.get(p.id):null;
    const variance=expected==null||wh==null?null:wh-expected;
    const inDiff=inward-(wi.get(p.id)||0),outDiff=outward-(wo.get(p.id)||0);
    let status='MATCH';
    if(baseQty==null)status='BASE STOCK MISSING';
    else if(wh==null)status='PHYSICAL STOCK MISSING';
    else if(Math.abs(variance||0)>.001)status='STOCK VARIANCE';
    else if(Math.abs(inDiff)>.001||Math.abs(outDiff)>.001)status='MOVEMENT MISMATCH';
    return {productId:p.id,product:p.catalogue_name,baseDate:b?.base_date||null,baseStock:baseQty,domesticInward:inward,domesticOutward:outward,todayDomesticInward:todayDi.get(p.id)||0,todayDomesticOutward:todayDo.get(p.id)||0,expectedClosing:expected,warehouseInward:wi.get(p.id)||0,warehouseOutward:wo.get(p.id)||0,physicalClosing:wh,stockVariance:variance,inwardDifference:inDiff,outwardDifference:outDiff,status};
  });
  const summary={products:rows.length,matched:rows.filter(r=>r.status==='MATCH').length,stockVariance:rows.filter(r=>r.status==='STOCK VARIANCE').length,movementMismatch:rows.filter(r=>r.status==='MOVEMENT MISMATCH').length,baseMissing:rows.filter(r=>r.status==='BASE STOCK MISSING').length,physicalMissing:rows.filter(r=>r.status==='PHYSICAL STOCK MISSING').length,domesticInward:(dm.data||[]).filter(r=>r.movement_type==='INWARD').reduce((s,r)=>s+Number(r.quantity||0),0),domesticOutward:(dm.data||[]).filter(r=>r.movement_type==='OUTWARD').reduce((s,r)=>s+Number(r.quantity||0),0)};
  res.json({date,summary,rows:rows.sort((a,b)=>Math.abs(b.stockVariance||0)-Math.abs(a.stockVariance||0))});
 }catch(e){res.status(500).json({error:e.message})}
});

app.use(express.static('dist'));
app.use((req,res)=>res.sendFile(process.cwd()+'/dist/index.html'));
app.listen(PORT,()=>console.log('Atomgrid Inventory V2 listening on '+PORT));
