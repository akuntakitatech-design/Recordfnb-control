import Decimal from 'decimal.js';
import type { PoolClient } from './db.js';
import { pool } from './db.js';

const ENGINE_VERSION = '0.13';
const dec = (value: string | number | null | undefined) => new Decimal(value || 0);
const TOLERANCE = new Decimal('0.000001');

type Header = {
  id: string;
  workspace_id: string;
  company_id: string;
  location_id: string | null;
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
  metadata: Record<string, unknown> | null;
  item_name: string | null;
  track_stock: boolean | null;
  base_unit_id: string | null;
  base_unit_code: string | null;
  inventory_account_id: string | null;
  stock_adjustment_account_id: string | null;
};

type StaleLine = {
  lineId: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnitCode: string;
  snapshot: string;
  current: string;
};

type PreviewLine = {
  lineId: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnitCode: string;
  systemQuantity: string;
  physicalQuantity: string;
  difference: string;
};

async function loadHeader(client: PoolClient, id: string, lock = false) {
  const result = await client.query<Header>(
    `SELECT id,workspace_id,company_id,location_id,transaction_number,transaction_date::text,workflow_status
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='STOCK_OPNAME'
      ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!result.rowCount) throw new Error('STOCK_OPNAME_NOT_FOUND');
  return result.rows[0];
}

async function loadLines(client: PoolClient, tx: Header) {
  const result = await client.query<Line>(
    `SELECT tl.id,tl.line_no,tl.item_id,tl.description,tl.quantity::text,tl.unit_id,tl.metadata,
            i.name item_name,i.track_stock,i.base_unit_id,u.code base_unit_code,
            COALESCE(io.inventory_account_id,cm.inventory_account_id) inventory_account_id,
            COALESCE(io.stock_adjustment_account_id,cm.stock_adjustment_account_id) stock_adjustment_account_id
       FROM transaction_lines tl
       LEFT JOIN items i ON i.id=tl.item_id
       LEFT JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN item_account_overrides io ON io.company_id=$2 AND io.item_id=tl.item_id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=$2 AND cm.category_id=i.category_id
      WHERE tl.transaction_id=$1
      ORDER BY tl.line_no`,
    [tx.id, tx.company_id],
  );
  if (!result.rowCount) throw new Error('STOCK_OPNAME_LINES_REQUIRED');
  return result.rows;
}

async function toBaseQty(client: PoolClient, tx: Header, line: Line) {
  if (!line.item_id || !line.base_unit_id) throw new Error(`ITEM_UNIT_REQUIRED_LINE_${line.line_no}`);
  const qty = dec(line.quantity);
  if (qty.lt(0)) throw new Error(`NEGATIVE_PHYSICAL_QTY_LINE_${line.line_no}`);
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

async function resolveAverageCost(client: PoolClient, tx: Header, itemId: string, currentAverage: string) {
  const current = dec(currentAverage);
  if (current.gt(0)) return current;
  if (!tx.location_id) throw new Error('LOCATION_REQUIRED');
  const result = await client.query<{ average_cost_after: string; unit_cost: string }>(
    `SELECT average_cost_after::text,unit_cost::text
       FROM inventory_movements
      WHERE company_id=$1 AND location_id=$2 AND item_id=$3
        AND (average_cost_after>0 OR unit_cost>0)
      ORDER BY created_at DESC
      LIMIT 1`,
    [tx.company_id, tx.location_id, itemId],
  );
  if (!result.rowCount) return new Decimal(0);
  const average = dec(result.rows[0].average_cost_after);
  return average.gt(0) ? average : dec(result.rows[0].unit_cost);
}

function snapshotOf(line: Line) {
  const raw = line.metadata?.systemQuantitySnapshot;
  if (raw === undefined || raw === null || raw === '') throw new Error(`STOCK_SNAPSHOT_REQUIRED_LINE_${line.line_no}`);
  return dec(String(raw));
}

export async function previewStockOpname(transactionId: string) {
  const client = await pool.connect();
  try {
    const tx = await loadHeader(client, transactionId);
    if (!tx.location_id) throw new Error('LOCATION_REQUIRED');
    const lines = await loadLines(client, tx);
    const stale: StaleLine[] = [];
    const preview: PreviewLine[] = [];

    for (const line of lines) {
      if (!line.item_id || !line.track_stock) throw new Error(`INVENTORY_ITEM_REQUIRED_LINE_${line.line_no}`);
      const snapshot = snapshotOf(line);
      const balance = await client.query<{ quantity_on_hand: string }>(
        `SELECT quantity_on_hand::text FROM inventory_balances
          WHERE company_id=$1 AND location_id=$2 AND item_id=$3`,
        [tx.company_id, tx.location_id, line.item_id],
      );
      const current = dec(balance.rows[0]?.quantity_on_hand);
      const physical = await toBaseQty(client, tx, line);
      if (current.sub(snapshot).abs().gt(TOLERANCE)) {
        stale.push({
          lineId: line.id, lineNo: line.line_no, itemId: line.item_id,
          itemName: line.item_name || 'Item', baseUnitCode: line.base_unit_code || '',
          snapshot: snapshot.toFixed(6), current: current.toFixed(6),
        });
      }
      preview.push({
        lineId: line.id, lineNo: line.line_no, itemId: line.item_id,
        itemName: line.item_name || 'Item', baseUnitCode: line.base_unit_code || '',
        systemQuantity: snapshot.toFixed(6), physicalQuantity: physical.toFixed(6),
        difference: physical.sub(snapshot).toFixed(6),
      });
    }

    return { stale, lines: preview };
  } finally {
    client.release();
  }
}

export async function verifyStockOpname(transactionId: string, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client, transactionId, true);
    if (!tx.location_id) throw new Error('LOCATION_REQUIRED');
    if (tx.workflow_status !== 'DRAFT') throw new Error(`TRANSACTION_STATUS_MUST_BE_DRAFT_${tx.workflow_status}`);

    const existing = await client.query<{ id: string; journal_number: string; status: string }>(
      `SELECT id,journal_number,status FROM journal_headers
        WHERE source_transaction_id=$1 AND status<>'VOID' LIMIT 1`,
      [tx.id],
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return { journal: existing.rows[0], adjustmentValue: '0.0000', adjustedLines: 0 };
    }

    const lines = await loadLines(client, tx);
    const journalLines: Array<{
      accountId: string;
      debit: Decimal;
      credit: Decimal;
      description: string;
      itemId: string;
      sourceLineId: string;
      metadata: Record<string, unknown>;
    }> = [];
    let adjustmentValue = new Decimal(0);
    let adjustedLines = 0;

    for (const line of lines) {
      if (!line.item_id || !line.track_stock) throw new Error(`INVENTORY_ITEM_REQUIRED_LINE_${line.line_no}`);
      if (!line.inventory_account_id) throw new Error(`INVENTORY_ACCOUNT_REQUIRED_LINE_${line.line_no}`);
      if (!line.stock_adjustment_account_id) throw new Error(`STOCK_ADJUSTMENT_ACCOUNT_REQUIRED_LINE_${line.line_no}`);

      await client.query(
        `INSERT INTO inventory_balances(workspace_id,company_id,location_id,item_id)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(company_id,location_id,item_id) DO NOTHING`,
        [tx.workspace_id, tx.company_id, tx.location_id, line.item_id],
      );
      const balance = await client.query<{ quantity_on_hand: string; average_cost: string }>(
        `SELECT quantity_on_hand::text,average_cost::text FROM inventory_balances
          WHERE company_id=$1 AND location_id=$2 AND item_id=$3 FOR UPDATE`,
        [tx.company_id, tx.location_id, line.item_id],
      );
      const current = dec(balance.rows[0]?.quantity_on_hand);
      const snapshot = snapshotOf(line);
      if (current.sub(snapshot).abs().gt(TOLERANCE)) throw new Error(`STOCK_OPNAME_BALANCE_CHANGED_LINE_${line.line_no}`);

      const physical = await toBaseQty(client, tx, line);
      const difference = physical.sub(current);
      if (difference.abs().lte(TOLERANCE)) {
        await client.query(
          `UPDATE transaction_lines
              SET unit_price=0,gross_amount=0,dpp_amount=0,tax_amount=0,line_total=0,
                  metadata=metadata || $1::jsonb
            WHERE id=$2`,
          [JSON.stringify({ physicalQuantityBase: physical.toFixed(6), differenceBase: '0.000000' }), line.id],
        );
        continue;
      }

      const average = await resolveAverageCost(client, tx, line.item_id, balance.rows[0]?.average_cost || '0');
      if (average.lte(0)) throw new Error(`MOVING_AVERAGE_NOT_AVAILABLE_LINE_${line.line_no}`);
      const movementQty = difference.abs();
      const value = movementQty.mul(average);
      adjustmentValue = adjustmentValue.add(value);
      adjustedLines += 1;
      const movementType = difference.gt(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';

      await client.query(
        `UPDATE inventory_balances
            SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
          WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
        [physical.toFixed(6), average.toFixed(6), tx.company_id, tx.location_id, line.item_id],
      );
      await client.query(
        `INSERT INTO inventory_movements(
           workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
           movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
        [tx.workspace_id, tx.company_id, tx.location_id, line.item_id, tx.id, line.id,
         movementType, movementQty.toFixed(6), average.toFixed(6), value.toFixed(4),
         physical.toFixed(6), average.toFixed(6), userId],
      );

      const entered = dec(line.quantity);
      const unitValue = entered.gt(0) ? value.div(entered) : average;
      await client.query(
        `UPDATE transaction_lines
            SET unit_price=$1,gross_amount=$2,dpp_amount=$2,tax_amount=0,line_total=$2,
                discount_type=NULL,discount_percent=0,discount_amount=0,document_discount_alloc=0,
                tax_code_id=NULL,tax_rate=0,tax_included=FALSE,
                metadata=metadata || $3::jsonb
          WHERE id=$4`,
        [unitValue.toFixed(4), value.toFixed(4),
         JSON.stringify({ physicalQuantityBase: physical.toFixed(6), differenceBase: difference.toFixed(6), adjustmentDirection: movementType }), line.id],
      );

      const description = line.description || `Stock opname ${line.item_name || ''}`.trim();
      const metadata = {
        costing: 'MOVING_AVERAGE', systemQuantity: current.toFixed(6),
        physicalQuantity: physical.toFixed(6), difference: difference.toFixed(6),
        adjustmentDirection: movementType,
      };
      if (difference.gt(0)) {
        journalLines.push({ accountId: line.inventory_account_id, debit: value, credit: new Decimal(0), description, itemId: line.item_id, sourceLineId: line.id, metadata });
        journalLines.push({ accountId: line.stock_adjustment_account_id, debit: new Decimal(0), credit: value, description, itemId: line.item_id, sourceLineId: line.id, metadata });
      } else {
        journalLines.push({ accountId: line.stock_adjustment_account_id, debit: value, credit: new Decimal(0), description, itemId: line.item_id, sourceLineId: line.id, metadata });
        journalLines.push({ accountId: line.inventory_account_id, debit: new Decimal(0), credit: value, description, itemId: line.item_id, sourceLineId: line.id, metadata });
      }
    }

    let journal: { id: string; journal_number: string; status: string } | null = null;
    if (journalLines.length) {
      const journalNumber = `AJ-${tx.transaction_number}`;
      const result = await client.query<{ id: string; journal_number: string; status: string }>(
        `INSERT INTO journal_headers(
           workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,
           status,description,engine_version)
         VALUES($1,$2,$3,$4,'AUTO_STOCK_OPNAME',$5,'DRAFT',$6,$7)
         RETURNING id,journal_number,status`,
        [tx.workspace_id, tx.company_id, journalNumber, tx.transaction_date, tx.id,
         `Auto journal ${tx.transaction_number}`, ENGINE_VERSION],
      );
      journal = result.rows[0];
      for (let index = 0; index < journalLines.length; index += 1) {
        const row = journalLines[index];
        await client.query(
          `INSERT INTO journal_lines(
             journal_id,line_no,account_id,debit,credit,description,location_id,item_id,
             source_transaction_line_id,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [journal.id, index + 1, row.accountId, row.debit.toFixed(4), row.credit.toFixed(4),
           row.description, tx.location_id, row.itemId, row.sourceLineId, JSON.stringify(row.metadata)],
        );
      }
    }

    await client.query(
      `UPDATE transaction_headers
          SET gross_amount=$1,line_discount_amount=0,document_discount_amount=0,dpp_amount=$1,
              tax_amount=0,grand_total=$1,workflow_status='FINANCE_VERIFIED',operational_status='FINANCE_VERIFIED',
              accounting_status=$2,verified_by=$3,verified_at=NOW(),updated_by=$3,updated_at=NOW()
        WHERE id=$4`,
      [adjustmentValue.toFixed(4), journal ? 'ACCOUNTING_REVIEW' : 'NO_JOURNAL_REQUIRED', userId, tx.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'FINANCE_VERIFY_STOCK_OPNAME',$4::jsonb)`,
      [tx.workspace_id, userId, tx.id, JSON.stringify({
        journalId: journal?.id || null, journalNumber: journal?.journal_number || null,
        adjustmentValue: adjustmentValue.toFixed(4), adjustedLines,
      })],
    );

    await client.query('COMMIT');
    return { journal, adjustmentValue: adjustmentValue.toFixed(4), adjustedLines };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
