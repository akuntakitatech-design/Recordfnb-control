import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canCreateTransaction } from './access.js';

export const clientSalesImportProfileRouter = Router();
clientSalesImportProfileRouter.use(requireAuth);

const text=(value:unknown)=>String(value??'').trim();
const upper=(value:unknown)=>text(value).toUpperCase();
const nullable=(value:unknown)=>text(value)||null;
const normalizeHeader=(value:unknown)=>upper(value).replace(/[^A-Z0-9]/g,'');
const paymentCodes=['CASH','QRIS','TRANSFER','COMPLIMENT','GOFOOD','GRABFOOD','SHOPEEFOOD','OTHER'] as const;
const canonicalFields=new Set([
  'saleDate','invoiceNumber','cashier','saleType','itemCode','itemName','quantity','unitPrice','discountAmount','lineTotal',
  'cash','qris','transfer','compliment','gofood','grabfood','shopeefood','other','paymentType','paymentAmount',
]);

function cleanMapping(value:unknown){
  const raw=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const out:Record<string,string>={};
  for(const [key,val] of Object.entries(raw)){
    if(!canonicalFields.has(key)) continue;
    const header=text(val);
    if(header) out[key]=header;
  }
  return out;
}
function cleanSignature(value:unknown){
  const raw=Array.isArray(value)?value:[];
  return [...new Set(raw.map(normalizeHeader).filter(Boolean))].sort();
}
function numberOption(value:unknown,fallback:string,allowed:string[]){const v=upper(value)||fallback;return allowed.includes(v)?v:fallback;}

async function companyWorkspace(companyId:string){
  const company=await query<{workspace_id:string}>('SELECT workspace_id FROM companies WHERE id=$1 AND status=\'ACTIVE\'',[companyId]);
  return company.rows[0]?.workspace_id||null;
}
async function profileForUser(profileId:string,userId:string){
  const profile=await query<{id:string;company_id:string;workspace_id:string}>(
    'SELECT id,company_id,workspace_id FROM sales_import_profiles WHERE id=$1',[profileId],
  );
  if(!profile.rowCount) return null;
  if(!(await canAccessCompany(userId,profile.rows[0].company_id))) return false;
  return profile.rows[0];
}

clientSalesImportProfileRouter.get('/sales-import-profiles',async(req,res)=>{
  const companyId=text(req.query.companyId);
  if(!companyId) return res.status(400).json({error:'COMPANY_REQUIRED'});
  if(!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  const result=await query(
    `SELECT p.id,p.company_id,p.name,p.provider,p.status,p.file_mode,p.header_row,p.delimiter,p.date_format,p.number_format,
            p.header_signature,p.column_mapping,p.settings,p.created_at,p.updated_at,
            (SELECT COUNT(*)::int FROM sales_import_item_aliases a WHERE a.profile_id=p.id) item_alias_count,
            (SELECT COUNT(*)::int FROM sales_import_payment_aliases a WHERE a.profile_id=p.id) payment_alias_count
       FROM sales_import_profiles p
      WHERE p.company_id=$1
      ORDER BY (p.status='ACTIVE') DESC,p.name`,
    [companyId],
  );
  res.json(result.rows);
});

clientSalesImportProfileRouter.get('/sales-import-profiles/:profileId',async(req,res)=>{
  const profileId=text(req.params.profileId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  const [profile,itemAliases,paymentAliases]=await Promise.all([
    query(`SELECT id,company_id,name,provider,status,file_mode,header_row,delimiter,date_format,number_format,header_signature,column_mapping,settings,created_at,updated_at FROM sales_import_profiles WHERE id=$1`,[profileId]),
    query(`SELECT a.id,a.external_code,a.external_name,a.item_id,i.code item_code,i.name item_name FROM sales_import_item_aliases a JOIN items i ON i.id=a.item_id WHERE a.profile_id=$1 ORDER BY COALESCE(NULLIF(a.external_code,''),a.external_name)`,[profileId]),
    query(`SELECT id,external_value,payment_code FROM sales_import_payment_aliases WHERE profile_id=$1 ORDER BY external_value`,[profileId]),
  ]);
  res.json({...profile.rows[0],itemAliases:itemAliases.rows,paymentAliases:paymentAliases.rows});
});

clientSalesImportProfileRouter.get('/sales-import-profile-items',async(req,res)=>{
  const companyId=text(req.query.companyId);
  if(!companyId) return res.status(400).json({error:'COMPANY_REQUIRED'});
  if(!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  const workspaceId=await companyWorkspace(companyId);
  if(!workspaceId) return res.status(404).json({error:'COMPANY_NOT_FOUND'});
  const items=await query(
    `SELECT i.id,i.code,i.name,c.name category_name FROM items i JOIN item_categories c ON c.id=i.category_id
      WHERE i.workspace_id=$1 AND i.status='ACTIVE' AND i.can_sell ORDER BY c.name,i.name`,
    [workspaceId],
  );
  res.json(items.rows);
});

clientSalesImportProfileRouter.post('/sales-import-profiles',async(req,res)=>{
  const companyId=text(req.body?.companyId);
  const name=text(req.body?.name);
  if(!companyId||!name) return res.status(400).json({error:'COMPANY_PROFILE_NAME_REQUIRED'});
  if(!(await canCreateTransaction(req.sessionUser!.id,companyId))) return res.status(403).json({error:'FORBIDDEN'});
  const workspaceId=await companyWorkspace(companyId);
  if(!workspaceId) return res.status(404).json({error:'COMPANY_NOT_FOUND'});
  const fileMode=numberOption(req.body?.fileMode,'WIDE',['WIDE','VERTICAL']);
  const headerRow=Number(req.body?.headerRow||1);
  if(!Number.isInteger(headerRow)||headerRow<1||headerRow>100) return res.status(400).json({error:'INVALID_HEADER_ROW'});
  const result=await query<{id:string}>(
    `INSERT INTO sales_import_profiles(workspace_id,company_id,name,provider,file_mode,header_row,delimiter,date_format,number_format,header_signature,column_mapping,settings,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$13) RETURNING id`,
    [workspaceId,companyId,name,nullable(req.body?.provider),fileMode,headerRow,text(req.body?.delimiter)||'AUTO',text(req.body?.dateFormat)||'AUTO',text(req.body?.numberFormat)||'AUTO',JSON.stringify(cleanSignature(req.body?.headerSignature)),JSON.stringify(cleanMapping(req.body?.columnMapping)),JSON.stringify(req.body?.settings&&typeof req.body.settings==='object'?req.body.settings:{}),req.sessionUser!.id],
  );
  await query(`INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'SALES_IMPORT_PROFILE',$3,'CREATE_IMPORT_PROFILE',$4::jsonb)`,[workspaceId,req.sessionUser!.id,result.rows[0].id,JSON.stringify({name,companyId,fileMode})]);
  res.status(201).json({id:result.rows[0].id});
});

clientSalesImportProfileRouter.put('/sales-import-profiles/:profileId',async(req,res)=>{
  const profileId=text(req.params.profileId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  if(!(await canCreateTransaction(req.sessionUser!.id,access.company_id))) return res.status(403).json({error:'FORBIDDEN'});
  const name=text(req.body?.name);
  if(!name) return res.status(400).json({error:'PROFILE_NAME_REQUIRED'});
  const status=numberOption(req.body?.status,'ACTIVE',['ACTIVE','INACTIVE']);
  const fileMode=numberOption(req.body?.fileMode,'WIDE',['WIDE','VERTICAL']);
  const headerRow=Number(req.body?.headerRow||1);
  if(!Number.isInteger(headerRow)||headerRow<1||headerRow>100) return res.status(400).json({error:'INVALID_HEADER_ROW'});
  await query(
    `UPDATE sales_import_profiles SET name=$1,provider=$2,status=$3,file_mode=$4,header_row=$5,delimiter=$6,date_format=$7,number_format=$8,
       header_signature=$9::jsonb,column_mapping=$10::jsonb,settings=$11::jsonb,updated_by=$12,updated_at=NOW() WHERE id=$13`,
    [name,nullable(req.body?.provider),status,fileMode,headerRow,text(req.body?.delimiter)||'AUTO',text(req.body?.dateFormat)||'AUTO',text(req.body?.numberFormat)||'AUTO',JSON.stringify(cleanSignature(req.body?.headerSignature)),JSON.stringify(cleanMapping(req.body?.columnMapping)),JSON.stringify(req.body?.settings&&typeof req.body.settings==='object'?req.body.settings:{}),req.sessionUser!.id,profileId],
  );
  await query(`INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'SALES_IMPORT_PROFILE',$3,'UPDATE_IMPORT_PROFILE',$4::jsonb)`,[access.workspace_id,req.sessionUser!.id,profileId,JSON.stringify({name,status,fileMode})]);
  res.json({ok:true});
});

clientSalesImportProfileRouter.delete('/sales-import-profiles/:profileId',async(req,res)=>{
  const profileId=text(req.params.profileId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  if(!(await canCreateTransaction(req.sessionUser!.id,access.company_id))) return res.status(403).json({error:'FORBIDDEN'});
  await query(`UPDATE sales_import_profiles SET status='INACTIVE',updated_by=$1,updated_at=NOW() WHERE id=$2`,[req.sessionUser!.id,profileId]);
  res.json({ok:true});
});

clientSalesImportProfileRouter.post('/sales-import-profiles/:profileId/item-aliases',async(req,res)=>{
  const profileId=text(req.params.profileId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  if(!(await canCreateTransaction(req.sessionUser!.id,access.company_id))) return res.status(403).json({error:'FORBIDDEN'});
  const externalCode=nullable(req.body?.externalCode);
  const externalName=text(req.body?.externalName);
  const itemId=text(req.body?.itemId);
  if((!externalCode&&!externalName)||!itemId) return res.status(400).json({error:'ALIAS_AND_ITEM_REQUIRED'});
  const item=await query('SELECT id FROM items WHERE id=$1 AND workspace_id=$2 AND status=\'ACTIVE\' AND can_sell',[itemId,access.workspace_id]);
  if(!item.rowCount) return res.status(400).json({error:'ITEM_OUTSIDE_WORKSPACE'});
  if(externalCode){
    await query(`INSERT INTO sales_import_item_aliases(profile_id,company_id,external_code,external_name,item_id,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(profile_id,UPPER(BTRIM(external_code))) WHERE external_code IS NOT NULL AND BTRIM(external_code)<>''
      DO UPDATE SET external_name=EXCLUDED.external_name,item_id=EXCLUDED.item_id,updated_at=NOW()`,[profileId,access.company_id,externalCode,externalName,itemId,req.sessionUser!.id]);
  }else{
    await query(`INSERT INTO sales_import_item_aliases(profile_id,company_id,external_code,external_name,item_id,created_by) VALUES($1,$2,NULL,$3,$4,$5)
      ON CONFLICT(profile_id,LOWER(BTRIM(external_name))) WHERE BTRIM(external_name)<>''
      DO UPDATE SET item_id=EXCLUDED.item_id,updated_at=NOW()`,[profileId,access.company_id,externalName,itemId,req.sessionUser!.id]);
  }
  res.json({ok:true});
});

clientSalesImportProfileRouter.delete('/sales-import-profiles/:profileId/item-aliases/:aliasId',async(req,res)=>{
  const profileId=text(req.params.profileId);const aliasId=text(req.params.aliasId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false||!(await canCreateTransaction(req.sessionUser!.id,access.company_id))) return res.status(403).json({error:'FORBIDDEN'});
  await query('DELETE FROM sales_import_item_aliases WHERE id=$1 AND profile_id=$2',[aliasId,profileId]);
  res.json({ok:true});
});

clientSalesImportProfileRouter.post('/sales-import-profiles/:profileId/payment-aliases',async(req,res)=>{
  const profileId=text(req.params.profileId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false||!(await canCreateTransaction(req.sessionUser!.id,access.company_id))) return res.status(403).json({error:'FORBIDDEN'});
  const externalValue=text(req.body?.externalValue);
  const paymentCode=upper(req.body?.paymentCode);
  if(!externalValue||!paymentCodes.includes(paymentCode as typeof paymentCodes[number])) return res.status(400).json({error:'INVALID_PAYMENT_ALIAS'});
  await query(`INSERT INTO sales_import_payment_aliases(profile_id,external_value,payment_code,created_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(profile_id,external_value) DO UPDATE SET payment_code=EXCLUDED.payment_code,updated_at=NOW()`,[profileId,externalValue,paymentCode,req.sessionUser!.id]);
  res.json({ok:true});
});

clientSalesImportProfileRouter.delete('/sales-import-profiles/:profileId/payment-aliases/:aliasId',async(req,res)=>{
  const profileId=text(req.params.profileId);const aliasId=text(req.params.aliasId);
  const access=await profileForUser(profileId,req.sessionUser!.id);
  if(access===null) return res.status(404).json({error:'IMPORT_PROFILE_NOT_FOUND'});
  if(access===false||!(await canCreateTransaction(req.sessionUser!.id,access.company_id))) return res.status(403).json({error:'FORBIDDEN'});
  await query('DELETE FROM sales_import_payment_aliases WHERE id=$1 AND profile_id=$2',[aliasId,profileId]);
  res.json({ok:true});
});

clientSalesImportProfileRouter.post('/sales-import-profiles/detect',async(req,res)=>{
  const companyId=text(req.body?.companyId);
  if(!companyId) return res.status(400).json({error:'COMPANY_REQUIRED'});
  if(!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  const incoming=new Set(cleanSignature(req.body?.headers));
  if(!incoming.size) return res.json({match:null,candidates:[]});
  const profiles=await query<{id:string;name:string;provider:string|null;header_signature:string[]}>(`SELECT id,name,provider,header_signature FROM sales_import_profiles WHERE company_id=$1 AND status='ACTIVE'`,[companyId]);
  const scored=profiles.rows.map(profile=>{
    const signature=new Set(cleanSignature(profile.header_signature));
    const intersection=[...incoming].filter(x=>signature.has(x)).length;
    const union=new Set([...incoming,...signature]).size;
    const score=union?intersection/union:0;
    return {id:profile.id,name:profile.name,provider:profile.provider,score:Number(score.toFixed(4)),exact:score===1};
  }).sort((a,b)=>b.score-a.score);
  const best=scored[0];
  res.json({match:best&&best.score>=0.8?best:null,candidates:scored.slice(0,5)});
});
