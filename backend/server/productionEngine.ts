import Decimal from 'decimal.js';
import type { PoolClient } from './db.js';
import { pool } from './db.js';
import { movingAverageAfterProduction } from '../shared/bomMath.js';

const ENGINE_VERSION = '0.15';
const dec = (value: string | number | null | undefined) => new Decimal(value || 0);

type Header = {
  id:string; workspace_id:string; company_id:string; location_id:string|null;
  transaction_number:string; transaction_date:string; workflow_status:string;
};

type Line = {
  id:string; line_no:number; item_id:string|null; description:string|null; quantity:string;
  unit_id:string|null; location_id:string|null; production_role:string|null; base_quantity:string|null;
  item_name:string|null; track_stock:boolean|null; base_unit_id:string|null; base_unit_code:string|null;
  inventory_account_id:string|null;
};

export type ProductionShortage = {
  lineId:string; lineNo:number; itemId:string; itemName:string; baseUnitCode:string;
  available:string; requested:string; after:string;
};

async function loadHeader(client:PoolClient,id:string,lock=false) {
  const r=await client.query<Header>(
    `SELECT id,workspace_id,company_id,location_id,transaction_number,transaction_date::text,workflow_status
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='PRODUCTION'
      ${lock?'FOR UPDATE':''}`,
    [id],
  );
  if(!r.rowCount) throw new Error('PRODUCTION_NOT_FOUND');
  return r.rows[0];
}

async function loadLines(client:PoolClient,tx:Header) {
  const r=await client.query<Line>(
    `SELECT tl.id,tl.line_no,tl.item_id,tl.description,tl.quantity::text,tl.unit_id,tl.location_id,
            tl.metadata->>'productionRole' production_role,
            tl.metadata->>'baseQuantity' base_quantity,
            i.name item_name,i.track_stock,i.base_unit_id,u.code base_unit_code,
            COALESCE(io.inventory_account_id,cm.inventory_account_id) inventory_account_id
       FROM transaction_lines tl
       LEFT JOIN items i ON i.id=tl.item_id
       LEFT JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN item_account_overrides io ON io.company_id=$2 AND io.item_id=tl.item_id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=$2 AND cm.category_id=i.category_id
      WHERE tl.transaction_id=$1
      ORDER BY tl.line_no`,
    [tx.id,tx.company_id],
  );
  if(!r.rowCount) throw new Error('PRODUCTION_LINES_REQUIRED');
  return r.rows;
}

async function averageCost(client:PoolClient,companyId:string,locationId:string,itemId:string,current:string) {
  const now=dec(current);
  if(now.gt(0)) return now;
  const r=await client.query<{average_cost_after:string;unit_cost:string}>(
    `SELECT average_cost_after::text,unit_cost::text
       FROM inventory_movements
      WHERE company_id=$1 AND location_id=$2 AND item_id=$3
        AND (average_cost_after>0 OR unit_cost>0)
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [companyId,locationId,itemId],
  );
  if(!r.rowCount) return new Decimal(0);
  const avg=dec(r.rows[0].average_cost_after);
  return avg.gt(0)?avg:dec(r.rows[0].unit_cost);
}

function lineBaseQuantity(line:Line) {
  const qty=dec(line.base_quantity || line.quantity);
  if(qty.lte(0)) throw new Error(`POSITIVE_QTY_REQUIRED_LINE_${line.line_no}`);
  return qty;
}

export async function previewProduction(id:string) {
  const client=await pool.connect();
  try {
    const tx=await loadHeader(client,id);
    if(!tx.location_id) throw new Error('PRODUCTION_LOCATION_REQUIRED');
    const lines=await loadLines(client,tx);
    const inputs=lines.filter(line=>line.production_role==='INPUT');
    const output=lines.find(line=>line.production_role==='OUTPUT');
    if(!inputs.length || !output) throw new Error('PRODUCTION_INPUT_OUTPUT_REQUIRED');
    const shortages:ProductionShortage[]=[];
    const virtual=new Map<string,Decimal>();
    let estimatedCost=new Decimal(0);

    for(const line of inputs) {
      if(!line.item_id || !line.track_stock) throw new Error(`INVENTORY_ITEM_REQUIRED_LINE_${line.line_no}`);
      const key=line.item_id;
      let available=virtual.get(key);
      let avg=new Decimal(0);
      if(available===undefined) {
        const b=await client.query<{quantity_on_hand:string;average_cost:string}>(
          `SELECT quantity_on_hand::text,average_cost::text
             FROM inventory_balances
            WHERE company_id=$1 AND location_id=$2 AND item_id=$3`,
          [tx.company_id,tx.location_id,line.item_id],
        );
        available=dec(b.rows[0]?.quantity_on_hand);
        avg=await averageCost(client,tx.company_id,tx.location_id,line.item_id,b.rows[0]?.average_cost||'0');
      } else {
        const b=await client.query<{average_cost:string}>(
          `SELECT average_cost::text FROM inventory_balances WHERE company_id=$1 AND location_id=$2 AND item_id=$3`,
          [tx.company_id,tx.location_id,line.item_id],
        );
        avg=await averageCost(client,tx.company_id,tx.location_id,line.item_id,b.rows[0]?.average_cost||'0');
      }
      if(avg.lte(0)) throw new Error(`MOVING_AVERAGE_NOT_AVAILABLE_LINE_${line.line_no}`);
      const requested=lineBaseQuantity(line);
      const after=available.sub(requested);
      if(after.lt(0)) shortages.push({
        lineId:line.id,lineNo:line.line_no,itemId:line.item_id,itemName:line.item_name||'Item',
        baseUnitCode:line.base_unit_code||'',available:available.toFixed(6),requested:requested.toFixed(6),after:after.toFixed(6),
      });
      estimatedCost=estimatedCost.add(requested.mul(avg));
      virtual.set(key,after);
    }

    const detail=await client.query<{batch_count:string;standard_output:string;actual_output:string;yield_percent:string}>(
      `SELECT batch_count::text,standard_output::text,actual_output::text,yield_percent::text
         FROM production_details WHERE transaction_id=$1`,[tx.id],
    );
    return { shortages, estimatedCost:estimatedCost.toFixed(4), production:detail.rows[0]||null };
  } finally { client.release(); }
}

export async function verifyProduction(id:string,userId:string,allowBelowZero=false) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const tx=await loadHeader(client,id,true);
    if(!tx.location_id) throw new Error('PRODUCTION_LOCATION_REQUIRED');
    const existing=await client.query<{id:string;journal_number:string;status:string}>(
      `SELECT id,journal_number,status FROM journal_headers WHERE source_transaction_id=$1 AND status<>'VOID' LIMIT 1`,[tx.id],
    );
    if(existing.rowCount) {
      await client.query('COMMIT');
      return { journal:existing.rows[0], shortages:[] as ProductionShortage[] };
    }
    if(tx.workflow_status!=='DRAFT') throw new Error(`TRANSACTION_STATUS_MUST_BE_DRAFT_${tx.workflow_status}`);

    const lines=await loadLines(client,tx);
    const inputs=lines.filter(line=>line.production_role==='INPUT');
    const output=lines.find(line=>line.production_role==='OUTPUT');
    if(!inputs.length || !output || !output.item_id || !output.track_stock) throw new Error('PRODUCTION_INPUT_OUTPUT_REQUIRED');
    if(!output.inventory_account_id) throw new Error('PRODUCTION_OUTPUT_INVENTORY_ACCOUNT_REQUIRED');

    const shortages:ProductionShortage[]=[];
    const journalCredits:Array<{accountId:string;value:Decimal;line:Line;meta:Record<string,unknown>}>=[];
    let totalCost=new Decimal(0);

    for(const line of inputs) {
      if(!line.item_id || !line.track_stock) throw new Error(`INVENTORY_ITEM_REQUIRED_LINE_${line.line_no}`);
      if(!line.inventory_account_id) throw new Error(`INVENTORY_ACCOUNT_REQUIRED_LINE_${line.line_no}`);
      const qty=lineBaseQuantity(line);
      await client.query(
        `INSERT INTO inventory_balances(workspace_id,company_id,location_id,item_id)
         VALUES($1,$2,$3,$4) ON CONFLICT(company_id,location_id,item_id) DO NOTHING`,
        [tx.workspace_id,tx.company_id,tx.location_id,line.item_id],
      );
      const b=await client.query<{quantity_on_hand:string;average_cost:string}>(
        `SELECT quantity_on_hand::text,average_cost::text FROM inventory_balances
          WHERE company_id=$1 AND location_id=$2 AND item_id=$3 FOR UPDATE`,
        [tx.company_id,tx.location_id,line.item_id],
      );
      const before=dec(b.rows[0]?.quantity_on_hand);
      const after=before.sub(qty);
      const below=after.lt(0);
      if(below) {
        shortages.push({lineId:line.id,lineNo:line.line_no,itemId:line.item_id,itemName:line.item_name||'Item',baseUnitCode:line.base_unit_code||'',available:before.toFixed(6),requested:qty.toFixed(6),after:after.toFixed(6)});
        if(!allowBelowZero) throw new Error('INVENTORY_SHORTAGE_CONFIRMATION_REQUIRED');
      }
      const avg=await averageCost(client,tx.company_id,tx.location_id,line.item_id,b.rows[0]?.average_cost||'0');
      if(avg.lte(0)) throw new Error(`MOVING_AVERAGE_NOT_AVAILABLE_LINE_${line.line_no}`);
      const value=qty.mul(avg);
      totalCost=totalCost.add(value);
      await client.query(
        `UPDATE inventory_balances SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
          WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
        [after.toFixed(6),avg.toFixed(6),tx.company_id,tx.location_id,line.item_id],
      );
      await client.query(
        `INSERT INTO inventory_movements(
           workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
           movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
         VALUES($1,$2,$3,$4,$5,$6,'PRODUCTION_OUT',$7,$8,$9,$10,$11,$12)
         ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
        [tx.workspace_id,tx.company_id,tx.location_id,line.item_id,tx.id,line.id,qty.toFixed(6),avg.toFixed(6),value.toFixed(4),after.toFixed(6),avg.toFixed(6),userId],
      );
      const entered=dec(line.quantity);
      await client.query(
        `UPDATE transaction_lines SET unit_price=$1,gross_amount=$2,dpp_amount=$2,tax_amount=0,line_total=$2 WHERE id=$3`,
        [value.div(entered).toFixed(4),value.toFixed(4),line.id],
      );
      journalCredits.push({
        accountId:line.inventory_account_id,value,line,
        meta:{costing:'MOVING_AVERAGE',productionRole:'INPUT',belowZeroOverride:below,quantityAfter:after.toFixed(6)},
      });
    }

    if(totalCost.lte(0)) throw new Error('ZERO_VALUE_PRODUCTION_NOT_ALLOWED');
    const outputQty=lineBaseQuantity(output);
    await client.query(
      `INSERT INTO inventory_balances(workspace_id,company_id,location_id,item_id)
       VALUES($1,$2,$3,$4) ON CONFLICT(company_id,location_id,item_id) DO NOTHING`,
      [tx.workspace_id,tx.company_id,tx.location_id,output.item_id],
    );
    const outBalance=await client.query<{quantity_on_hand:string;average_cost:string}>(
      `SELECT quantity_on_hand::text,average_cost::text FROM inventory_balances
        WHERE company_id=$1 AND location_id=$2 AND item_id=$3 FOR UPDATE`,
      [tx.company_id,tx.location_id,output.item_id],
    );
    const beforeOutput=dec(outBalance.rows[0]?.quantity_on_hand);
    const beforeAvg=dec(outBalance.rows[0]?.average_cost);
    const afterOutput=beforeOutput.add(outputQty);
    const newAverage=movingAverageAfterProduction(beforeOutput,beforeAvg,outputQty,totalCost);
    const productionUnitCost=totalCost.div(outputQty);
    await client.query(
      `UPDATE inventory_balances SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
        WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
      [afterOutput.toFixed(6),newAverage.toFixed(6),tx.company_id,tx.location_id,output.item_id],
    );
    await client.query(
      `INSERT INTO inventory_movements(
         workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
         movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
       VALUES($1,$2,$3,$4,$5,$6,'PRODUCTION_IN',$7,$8,$9,$10,$11,$12)
       ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
      [tx.workspace_id,tx.company_id,tx.location_id,output.item_id,tx.id,output.id,outputQty.toFixed(6),productionUnitCost.toFixed(6),totalCost.toFixed(4),afterOutput.toFixed(6),newAverage.toFixed(6),userId],
    );
    await client.query(
      `UPDATE transaction_lines SET unit_price=$1,gross_amount=$2,dpp_amount=$2,tax_amount=0,line_total=$2 WHERE id=$3`,
      [productionUnitCost.toFixed(4),totalCost.toFixed(4),output.id],
    );

    const journalNumber=`AJ-${tx.transaction_number}`;
    const j=await client.query<{id:string;journal_number:string;status:string}>(
      `INSERT INTO journal_headers(workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
       VALUES($1,$2,$3,$4,'AUTO_PRODUCTION',$5,'DRAFT',$6,$7)
       RETURNING id,journal_number,status`,
      [tx.workspace_id,tx.company_id,journalNumber,tx.transaction_date,tx.id,`Auto journal ${tx.transaction_number}`,ENGINE_VERSION],
    );
    let lineNo=1;
    await client.query(
      `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,item_id,source_transaction_line_id,metadata)
       VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9::jsonb)`,
      [j.rows[0].id,lineNo++,output.inventory_account_id,totalCost.toFixed(4),`Hasil produksi ${output.item_name||''}`.trim(),tx.location_id,output.item_id,output.id,JSON.stringify({costing:'PRODUCTION_ACTUAL',productionRole:'OUTPUT',quantityAfter:afterOutput.toFixed(6),averageCostAfter:newAverage.toFixed(6)})],
    );
    for(const credit of journalCredits) {
      await client.query(
        `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,item_id,source_transaction_line_id,metadata)
         VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,$9::jsonb)`,
        [j.rows[0].id,lineNo++,credit.accountId,credit.value.toFixed(4),`Bahan produksi ${credit.line.item_name||''}`.trim(),tx.location_id,credit.line.item_id,credit.line.id,JSON.stringify(credit.meta)],
      );
    }

    await client.query(
      `UPDATE transaction_headers SET gross_amount=$1,line_discount_amount=0,document_discount_amount=0,dpp_amount=$1,tax_amount=0,grand_total=$1,
              workflow_status='FINANCE_VERIFIED',operational_status='FINANCE_VERIFIED',accounting_status='ACCOUNTING_REVIEW',
              negative_stock_override=$2,verified_by=$3,verified_at=NOW(),updated_by=$3,updated_at=NOW()
        WHERE id=$4`,
      [totalCost.toFixed(4),shortages.length>0,userId,tx.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,$4,$5::jsonb)`,
      [tx.workspace_id,userId,tx.id,shortages.length?'FINANCE_VERIFY_PRODUCTION_WITH_OVERRIDE':'FINANCE_VERIFY_PRODUCTION',JSON.stringify({journalId:j.rows[0].id,journalNumber,totalCost:totalCost.toFixed(4),shortages,outputQuantity:outputQty.toFixed(6)})],
    );
    await client.query('COMMIT');
    return {journal:j.rows[0],shortages,totalCost:totalCost.toFixed(4),unitCost:productionUnitCost.toFixed(6),outputQuantity:outputQty.toFixed(6)};
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
