import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { previewItemUsage, verifyItemUsage } from './itemUsageEngine.js';

export const clientItemUsageRouter=Router();
clientItemUsageRouter.use(requireAuth);

const text=(v:unknown)=>String(v??'').trim();
const nullable=(v:unknown)=>{const x=text(v);return x||null;};

async function nextNumber(client:any,companyId:string,date:string){
  const year=Number(date.slice(0,4));
  const r=await client.query(`INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number) VALUES($1,'STOCK_USAGE',$2,1) ON CONFLICT(company_id,transaction_type,sequence_year) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number`,[companyId,year]);
  return `PBK-${year}-${String(r.rows[0].last_number).padStart(5,'0')}`;
}

async function canOverride(userId:string,companyId:string){
  const r=await query(`SELECT 1 FROM users u WHERE u.id=$1 AND u.status='ACTIVE' AND u.is_system_admin UNION ALL SELECT 1 FROM companies c JOIN workspace_memberships wm ON wm.workspace_id=c.workspace_id JOIN roles ro ON ro.id=wm.role_id WHERE c.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE' AND (wm.company_id IS NULL OR wm.company_id=c.id) AND ro.code=ANY($3::text[]) LIMIT 1`,[userId,companyId,['AK_SUPER_ADMIN','AK_ACCOUNTING_REVIEWER','AK_ACCOUNTING_STAFF','CLIENT_FINANCE_MANAGER']]);
  return Boolean(r.rowCount);
}

clientItemUsageRouter.get('/item-usage-balances',async(req,res)=>{
  const companyId=text(req.query.companyId),locationId=text(req.query.locationId);
  if(!companyId||!locationId)return res.status(400).json({error:'COMPANY_LOCATION_REQUIRED'});
  if(!(await canAccessCompany(req.sessionUser!.id,companyId))||!(await canAccessLocation(req.sessionUser!.id,locationId)))return res.status(403).json({error:'FORBIDDEN'});
  const r=await query(`SELECT i.id item_id,i.code,i.name,i.category_id,c.name category_name,i.base_unit_id,u.code base_unit_code,u.name base_unit_name,COALESCE(ib.quantity_on_hand,0)::text quantity_on_hand,(COALESCE(io.inventory_account_id,cm.inventory_account_id) IS NOT NULL AND COALESCE(io.usage_account_id,cm.usage_account_id,io.cogs_account_id,cm.cogs_account_id) IS NOT NULL) setup_ready FROM companies co JOIN items i ON i.workspace_id=co.workspace_id AND i.status='ACTIVE' AND i.track_stock LEFT JOIN item_categories c ON c.id=i.category_id LEFT JOIN units u ON u.id=i.base_unit_id LEFT JOIN inventory_balances ib ON ib.company_id=co.id AND ib.location_id=$2 AND ib.item_id=i.id LEFT JOIN item_account_overrides io ON io.company_id=co.id AND io.item_id=i.id LEFT JOIN item_category_account_mappings cm ON cm.company_id=co.id AND cm.category_id=i.category_id WHERE co.id=$1 ORDER BY c.name,i.name`,[companyId,locationId]);
  res.json(r.rows);
});

clientItemUsageRouter.get('/item-usages',async(req,res)=>{
  const companyId=text(req.query.companyId);
  if(companyId&&!(await canAccessCompany(req.sessionUser!.id,companyId)))return res.status(403).json({error:'FORBIDDEN_COMPANY'});
  const r=await query(`SELECT t.id,t.company_id,t.location_id,t.transaction_number,t.transaction_date,t.notes,t.grand_total::text,t.workflow_status,t.accounting_status,t.negative_stock_override,l.name location_name,COUNT(tl.id)::int line_count FROM transaction_headers t LEFT JOIN locations l ON l.id=t.location_id LEFT JOIN transaction_lines tl ON tl.transaction_id=t.id WHERE t.transaction_type='STOCK_USAGE' AND ($1='' OR t.company_id=$1::uuid) AND (EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE') OR EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE' AND (wm.company_id IS NULL OR wm.company_id=t.company_id) AND (wm.location_id IS NULL OR wm.location_id=t.location_id))) GROUP BY t.id,l.name ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 100`,[companyId,req.sessionUser!.id]);
  res.json(r.rows);
});

clientItemUsageRouter.post('/item-usages',async(req,res)=>{
  const companyId=text(req.body?.companyId),locationId=text(req.body?.locationId),transactionDate=text(req.body?.transactionDate),notes=nullable(req.body?.notes);
  const raw=Array.isArray(req.body?.lines)?req.body.lines:[];
  if(!companyId||!locationId||!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)||!raw.length)return res.status(400).json({error:'ITEM_USAGE_REQUIRED_FIELDS'});
  if(!(await canCreateTransaction(req.sessionUser!.id,companyId)))return res.status(403).json({error:'FORBIDDEN'});
  const company=await query<{workspace_id:string}>(`SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,[companyId]);
  if(!company.rowCount)return res.status(404).json({error:'COMPANY_NOT_FOUND'});
  if(!(await canAccessLocation(req.sessionUser!.id,locationId)))return res.status(403).json({error:'LOCATION_FORBIDDEN'});
  const loc=await query(`SELECT 1 FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,[locationId,companyId]);if(!loc.rowCount)return res.status(400).json({error:'LOCATION_OUTSIDE_COMPANY'});
  const client=await pool.connect();
  try{await client.query('BEGIN');const number=await nextNumber(client,companyId,transactionDate);const header=await client.query(`INSERT INTO transaction_headers(workspace_id,company_id,location_id,transaction_type,transaction_number,transaction_date,notes,payment_status,gross_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by) VALUES($1,$2,$3,'STOCK_USAGE',$4,$5,$6,'N/A',0,0,0,0,$7,$7) RETURNING id,transaction_number,transaction_date,workflow_status,accounting_status`,[company.rows[0].workspace_id,companyId,locationId,number,transactionDate,notes,req.sessionUser!.id]);
    for(let i=0;i<raw.length;i++){const line=raw[i];const itemId=text(line.itemId),unitId=text(line.unitId),description=nullable(line.description),costCenterId=nullable(line.costCenterId),qty=Number(line.quantity);if(!itemId||!unitId||!Number.isFinite(qty)||qty<=0)throw new Error(`INVALID_ITEM_USAGE_LINE_${i+1}`);const item=await client.query<{base_unit_id:string}>(`SELECT base_unit_id FROM items WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE' AND track_stock`,[itemId,company.rows[0].workspace_id]);if(!item.rowCount)throw new Error(`INVALID_ITEM_LINE_${i+1}`);if(unitId!==item.rows[0].base_unit_id){const conv=await client.query(`SELECT 1 FROM unit_conversions WHERE workspace_id=$1 AND from_unit_id=$2 AND to_unit_id=$3 AND (item_id=$4 OR item_id IS NULL) LIMIT 1`,[company.rows[0].workspace_id,unitId,item.rows[0].base_unit_id,itemId]);if(!conv.rowCount)throw new Error(`INVALID_UNIT_LINE_${i+1}`);}if(costCenterId){const cc=await client.query(`SELECT 1 FROM cost_centers WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,[costCenterId,companyId]);if(!cc.rowCount)throw new Error(`INVALID_COST_CENTER_LINE_${i+1}`);}await client.query(`INSERT INTO transaction_lines(transaction_id,line_no,line_type,item_id,description,quantity,unit_id,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id,cost_center_id) VALUES($1,$2,'ITEM',$3,$4,$5,$6,0,0,0,0,0,$7,$8)`,[header.rows[0].id,i+1,itemId,description,qty,unitId,locationId,costCenterId]);}
    await client.query(`INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_ITEM_USAGE',$4::jsonb)`,[company.rows[0].workspace_id,req.sessionUser!.id,header.rows[0].id,JSON.stringify({transactionNumber:number,lineCount:raw.length})]);await client.query('COMMIT');res.status(201).json(header.rows[0]);
  }catch(error){await client.query('ROLLBACK');console.error('Create item usage failed:',error);res.status(400).json({error:error instanceof Error?error.message:'CREATE_ITEM_USAGE_FAILED'});}finally{client.release();}
});

clientItemUsageRouter.get('/item-usages/:transactionId/preview',async(req,res)=>{
  const id=text(req.params.transactionId);const tx=await query<{company_id:string;location_id:string|null}>(`SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='STOCK_USAGE'`,[id]);if(!tx.rowCount)return res.status(404).json({error:'ITEM_USAGE_NOT_FOUND'});if(!(await canVerifyTransaction(req.sessionUser!.id,tx.rows[0].company_id)))return res.status(403).json({error:'FINANCE_VERIFY_ROLE_REQUIRED'});if(tx.rows[0].location_id&&!(await canAccessLocation(req.sessionUser!.id,tx.rows[0].location_id)))return res.status(403).json({error:'LOCATION_FORBIDDEN'});try{res.json(await previewItemUsage(id));}catch(error){res.status(400).json({error:error instanceof Error?error.message:'PREVIEW_FAILED'});}
});

clientItemUsageRouter.post('/item-usages/:transactionId/verify',async(req,res)=>{
  const id=text(req.params.transactionId),allowBelowZero=Boolean(req.body?.allowBelowZero);const tx=await query<{company_id:string;location_id:string|null}>(`SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='STOCK_USAGE'`,[id]);if(!tx.rowCount)return res.status(404).json({error:'ITEM_USAGE_NOT_FOUND'});if(!(await canVerifyTransaction(req.sessionUser!.id,tx.rows[0].company_id)))return res.status(403).json({error:'FINANCE_VERIFY_ROLE_REQUIRED'});if(tx.rows[0].location_id&&!(await canAccessLocation(req.sessionUser!.id,tx.rows[0].location_id)))return res.status(403).json({error:'LOCATION_FORBIDDEN'});if(allowBelowZero&&!(await canOverride(req.sessionUser!.id,tx.rows[0].company_id)))return res.status(403).json({error:'INVENTORY_OVERRIDE_MANAGER_REQUIRED'});try{const result=await verifyItemUsage(id,req.sessionUser!.id,allowBelowZero);res.json({ok:true,...result});}catch(error){console.error('Verify item usage failed:',error);res.status(400).json({error:error instanceof Error?error.message:'VERIFY_ITEM_USAGE_FAILED'});}
});
