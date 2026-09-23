import Decimal from 'decimal.js';
import type { PoolClient } from './db.js';
import { pool } from './db.js';

const ENGINE_VERSION = '0.12';
const amount = (value: string | number | null | undefined) => new Decimal(value || 0);

type Header = {
  id: string;
  workspace_id: string;
  company_id: string;
  location_id: string | null;
  transfer_to_location_id: string | null;
  transaction_number: string;
  transaction_date: string;
  workflow_status: string;
};

type Line = {
  id: string;
  line_no: number;
  item_id: string | null;
  description: string | null;
  quantity: string;
  unit_id: string | null;
  item_name: string | null;
  track_stock: boolean | null;
  base_unit_id: string | null;
  base_unit_code: string | null;
  inventory_account_id: string | null;
};

type Shortage = {
  lineId: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnitCode: string;
  available: string;
  requested: string;
  after: string;
};

async function loadHeader(client: PoolClient, id: string, lock = false) {
  const result = await client.query<Header>(
    `SELECT id,workspace_id,company_id,location_id,transfer_to_location_id,
            transaction_number,transaction_date::text,workflow_status
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='STOCK_TRANSFER'
      ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!result.rowCount) throw new Error('STOCK_TRANSFER_NOT_FOUND');
  return result.rows[0];
}

async function loadLines(client: PoolClient, tx: Header) {
  const result = await client.query<Line>(
    `SELECT tl.id,tl.line_no,tl.item_id,tl.description,tl.quantity::text,tl.unit_id,
            i.name item_name,i.track_stock,i.base_unit_id,u.code base_unit_code,
            COALESCE(io.inventory_account_id,cm.inventory_account_id) inventory_account_id
       FROM transaction_lines tl
       LEFT JOIN items i ON i.id=tl.item_id
       LEFT JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN item_account_overrides io ON io.company_id=$2 AND io.item_id=tl.item_id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=$2 AND cm.category_id=i.category_id
      WHERE tl.transaction_id=$1
      ORDER BY tl.line_no`,
    [tx.id, tx.company_id],
  );
  if (!result.rowCount) throw new Error('STOCK_TRANSFER_LINES_REQUIRED');
  return result.rows;
}

async function resolveBaseQuantity(client: PoolClient, tx: Header, line: Line) {
  if (!line.item_id || !line.base_unit_id) throw new Error(`ITEM_UNIT_REQUIRED_LINE_${line.line_no}`);
  const qty = amount(line.quantity);
  if (qty.lte(0)) throw new Error(`POSITIVE_QTY_REQUIRED_LINE_${line.line_no}`);
  if (!line.unit_id || line.unit_id === line.base_unit_id) return qty;

  const conversion = await client.query<{ multiplier: string }>(
    `SELECT multiplier::text
       FROM unit_conversions
      WHERE workspace_id=$1 AND from_unit_id=$2 AND to_unit_id=$3
        AND (item_id=$4 OR item_id IS NULL)
      ORDER BY (item_id IS NOT NULL) DESC
      LIMIT 1`,
    [tx.workspace_id, line.unit_id, line.base_unit_id, line.item_id],
  );
  if (!conversion.rowCount) throw new Error(`UNIT_CONVERSION_REQUIRED_LINE_${line.line_no}`);
  return qty.mul(conversion.rows[0].multiplier);
}

async function resolveAverageCost(
  client: PoolClient,
  companyId: string,
  locationId: string,
  itemId: string,
  currentAverage: string,
) {
  const current = amount(currentAverage);
  if (current.gt(0)) return current;

  const result = await client.query<{ average_cost_after: string; unit_cost: string }>(
    `SELECT average_cost_after::text,unit_cost::text
       FROM inventory_movements
      WHERE company_id=$1 AND location_id=$2 AND item_id=$3
        AND (average_cost_after>0 OR unit_cost>0)
      ORDER BY created_at DESC
      LIMIT 1`,
    [companyId, locationId, itemId],
  );
  if (!result.rowCount) return new Decimal(0);
  const average = amount(result.rows[0].average_cost_after);
  return average.gt(0) ? average : amount(result.rows[0].unit_cost);
}

export async function previewStockTransfer(transactionId: string) {
  const client = await pool.connect();
  try {
    const tx = await loadHeader(client, transactionId);
    if (!tx.location_id || !tx.transfer_to_location_id) throw new Error('TRANSFER_LOCATIONS_REQUIRED');
    const lines = await loadLines(client, tx);
    const virtualBalances = new Map<string, Decimal>();
    const shortages: Shortage[] = [];

    for (const line of lines) {
      if (!line.item_id || !line.track_stock) throw new Error(`INVENTORY_ITEM_REQUIRED_LINE_${line.line_no}`);
      const key = `${tx.location_id}:${line.item_id}`;
      let available = virtualBalances.get(key);
      if (available === undefined) {
        const balance = await client.query<{ quantity_on_hand: string }>(
          `SELECT quantity_on_hand::text
             FROM inventory_balances
            WHERE company_id=$1 AND location_id=$2 AND item_id=$3`,
          [tx.company_id, tx.location_id, line.item_id],
        );
        available = amount(balance.rows[0]?.quantity_on_hand);
      }
      const requested = await resolveBaseQuantity(client, tx, line);
      const after = available.sub(requested);
      if (after.lt(0)) {
        shortages.push({
          lineId: line.id,
          lineNo: line.line_no,
          itemId: line.item_id,
          itemName: line.item_name || 'Item',
          baseUnitCode: line.base_unit_code || '',
          available: available.toFixed(6),
          requested: requested.toFixed(6),
          after: after.toFixed(6),
        });
      }
      virtualBalances.set(key, after);
    }

    return { shortages };
  } finally {
    client.release();
  }
}

export async function verifyStockTransfer(transactionId: string, userId: string, allowBelowZero = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client, transactionId, true);
    if (!tx.location_id || !tx.transfer_to_location_id) throw new Error('TRANSFER_LOCATIONS_REQUIRED');
    if (tx.location_id === tx.transfer_to_location_id) throw new Error('TRANSFER_LOCATIONS_MUST_DIFFER');

    const existing = await client.query<{ id: string; journal_number: string; status: string }>(
      `SELECT id,journal_number,status
         FROM journal_headers
        WHERE source_transaction_id=$1 AND status<>'VOID'
        LIMIT 1`,
      [tx.id],
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return { journal: existing.rows[0], shortages: [] as Shortage[] };
    }
    if (tx.workflow_status !== 'DRAFT') throw new Error(`TRANSACTION_STATUS_MUST_BE_DRAFT_${tx.workflow_status}`);

    const lines = await loadLines(client, tx);
    const journalLines: Array<{
      accountId: string;
      debit: Decimal;
      credit: Decimal;
      description: string;
      locationId: string;
      itemId: string;
      sourceLineId: string;
      metadata: Record<string, unknown>;
    }> = [];
    const shortages: Shortage[] = [];
    let transferTotal = new Decimal(0);

    for (const line of lines) {
      if (!line.item_id || !line.track_stock) throw new Error(`INVENTORY_ITEM_REQUIRED_LINE_${line.line_no}`);
      if (!line.inventory_account_id) throw new Error(`INVENTORY_ACCOUNT_REQUIRED_LINE_${line.line_no}`);

      const qtyBase = await resolveBaseQuantity(client, tx, line);

      await client.query(
        `INSERT INTO inventory_balances(workspace_id,company_id,location_id,item_id)
         VALUES($1,$2,$3,$4),($1,$2,$5,$4)
         ON CONFLICT(company_id,location_id,item_id) DO NOTHING`,
        [tx.workspace_id, tx.company_id, tx.location_id, line.item_id, tx.transfer_to_location_id],
      );

      const balances = await client.query<{ location_id: string; quantity_on_hand: string; average_cost: string }>(
        `SELECT location_id,quantity_on_hand::text,average_cost::text
           FROM inventory_balances
          WHERE company_id=$1 AND item_id=$2 AND location_id=ANY($3::uuid[])
          ORDER BY location_id
          FOR UPDATE`,
        [tx.company_id, line.item_id, [tx.location_id, tx.transfer_to_location_id]],
      );
      const source = balances.rows.find(row => row.location_id === tx.location_id);
      const destination = balances.rows.find(row => row.location_id === tx.transfer_to_location_id);
      if (!source || !destination) throw new Error(`INVENTORY_BALANCE_REQUIRED_LINE_${line.line_no}`);

      const sourceBefore = amount(source.quantity_on_hand);
      const sourceAfter = sourceBefore.sub(qtyBase);
      const belowZero = sourceAfter.lt(0);
      if (belowZero) {
        shortages.push({
          lineId: line.id,
          lineNo: line.line_no,
          itemId: line.item_id,
          itemName: line.item_name || 'Item',
          baseUnitCode: line.base_unit_code || '',
          available: sourceBefore.toFixed(6),
          requested: qtyBase.toFixed(6),
          after: sourceAfter.toFixed(6),
        });
        if (!allowBelowZero) throw new Error('INVENTORY_SHORTAGE_CONFIRMATION_REQUIRED');
      }

      const sourceAverage = await resolveAverageCost(
        client,
        tx.company_id,
        tx.location_id,
        line.item_id,
        source.average_cost,
      );
      if (sourceAverage.lte(0)) throw new Error(`MOVING_AVERAGE_NOT_AVAILABLE_LINE_${line.line_no}`);

      const transferValue = qtyBase.mul(sourceAverage);
      transferTotal = transferTotal.add(transferValue);
      const destinationBefore = amount(destination.quantity_on_hand);
      const destinationAfter = destinationBefore.add(qtyBase);
      const destinationAverageBefore = amount(destination.average_cost);
      let destinationAverageAfter = sourceAverage;
      if (destinationBefore.gt(0) && destinationAverageBefore.gt(0) && destinationAfter.gt(0)) {
        destinationAverageAfter = destinationBefore.mul(destinationAverageBefore).add(transferValue).div(destinationAfter);
      }

      await client.query(
        `UPDATE inventory_balances
            SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
          WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
        [sourceAfter.toFixed(6), sourceAverage.toFixed(6), tx.company_id, tx.location_id, line.item_id],
      );
      await client.query(
        `UPDATE inventory_balances
            SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
          WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
        [destinationAfter.toFixed(6), destinationAverageAfter.toFixed(6), tx.company_id, tx.transfer_to_location_id, line.item_id],
      );

      await client.query(
        `INSERT INTO inventory_movements(
           workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
           movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
         VALUES($1,$2,$3,$4,$5,$6,'TRANSFER_OUT',$7,$8,$9,$10,$11,$12)
         ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
        [tx.workspace_id, tx.company_id, tx.location_id, line.item_id, tx.id, line.id,
         qtyBase.toFixed(6), sourceAverage.toFixed(6), transferValue.toFixed(4), sourceAfter.toFixed(6), sourceAverage.toFixed(6), userId],
      );
      await client.query(
        `INSERT INTO inventory_movements(
           workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
           movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
         VALUES($1,$2,$3,$4,$5,$6,'TRANSFER_IN',$7,$8,$9,$10,$11,$12)
         ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
        [tx.workspace_id, tx.company_id, tx.transfer_to_location_id, line.item_id, tx.id, line.id,
         qtyBase.toFixed(6), sourceAverage.toFixed(6), transferValue.toFixed(4), destinationAfter.toFixed(6), destinationAverageAfter.toFixed(6), userId],
      );

      const enteredQty = amount(line.quantity);
      const displayedUnitCost = enteredQty.gt(0) ? transferValue.div(enteredQty) : new Decimal(0);
      await client.query(
        `UPDATE transaction_lines
            SET unit_price=$1,gross_amount=$2,dpp_amount=$2,tax_amount=0,line_total=$2,
                discount_type=NULL,discount_percent=0,discount_amount=0,document_discount_alloc=0,
                tax_code_id=NULL,tax_rate=0,tax_included=FALSE
          WHERE id=$3`,
        [displayedUnitCost.toFixed(4), transferValue.toFixed(4), line.id],
      );

      const metadata = {
        costing: 'MOVING_AVERAGE',
        transferFromLocationId: tx.location_id,
        transferToLocationId: tx.transfer_to_location_id,
        sourceQuantityAfter: sourceAfter.toFixed(6),
        destinationQuantityAfter: destinationAfter.toFixed(6),
        belowZeroOverride: belowZero,
      };
      const description = line.description || `Transfer ${line.item_name || ''}`.trim();
      journalLines.push({
        accountId: line.inventory_account_id,
        debit: new Decimal(0),
        credit: transferValue,
        description,
        locationId: tx.location_id,
        itemId: line.item_id,
        sourceLineId: line.id,
        metadata,
      });
      journalLines.push({
        accountId: line.inventory_account_id,
        debit: transferValue,
        credit: new Decimal(0),
        description,
        locationId: tx.transfer_to_location_id,
        itemId: line.item_id,
        sourceLineId: line.id,
        metadata,
      });
    }

    if (transferTotal.lte(0)) throw new Error('ZERO_VALUE_STOCK_TRANSFER_NOT_ALLOWED');
    const journalNumber = `AJ-${tx.transaction_number}`;
    const journal = await client.query<{ id: string; journal_number: string; status: string }>(
      `INSERT INTO journal_headers(
         workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,
         status,description,engine_version)
       VALUES($1,$2,$3,$4,'AUTO_STOCK_TRANSFER',$5,'DRAFT',$6,$7)
       RETURNING id,journal_number,status`,
      [tx.workspace_id, tx.company_id, journalNumber, tx.transaction_date, tx.id,
       `Auto journal ${tx.transaction_number}`, ENGINE_VERSION],
    );

    for (let index = 0; index < journalLines.length; index += 1) {
      const line = journalLines[index];
      await client.query(
        `INSERT INTO journal_lines(
           journal_id,line_no,account_id,debit,credit,description,location_id,item_id,
           source_transaction_line_id,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [journal.rows[0].id, index + 1, line.accountId, line.debit.toFixed(4), line.credit.toFixed(4),
         line.description, line.locationId, line.itemId, line.sourceLineId, JSON.stringify(line.metadata)],
      );
    }

    await client.query(
      `UPDATE transaction_headers
          SET gross_amount=$1,line_discount_amount=0,document_discount_amount=0,dpp_amount=$1,
              tax_amount=0,grand_total=$1,workflow_status='FINANCE_VERIFIED',
              operational_status='FINANCE_VERIFIED',accounting_status='ACCOUNTING_REVIEW',
              negative_stock_override=$2,verified_by=$3,verified_at=NOW(),updated_by=$3,updated_at=NOW()
        WHERE id=$4`,
      [transferTotal.toFixed(4), shortages.length > 0, userId, tx.id],
    );

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,$4,$5::jsonb)`,
      [tx.workspace_id, userId, tx.id,
       shortages.length ? 'FINANCE_VERIFY_STOCK_TRANSFER_WITH_OVERRIDE' : 'FINANCE_VERIFY_STOCK_TRANSFER',
       JSON.stringify({ journalId: journal.rows[0].id, journalNumber, transferTotal: transferTotal.toFixed(4), shortages })],
    );

    await client.query('COMMIT');
    return { journal: journal.rows[0], shortages, total: transferTotal.toFixed(4) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
