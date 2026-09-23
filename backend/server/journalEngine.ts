import Decimal from 'decimal.js';
import type { PoolClient } from './db.js';
import { pool } from './db.js';

const ENGINE_VERSION = '0.8';

type TxHeader = {
  id: string;
  workspace_id: string;
  company_id: string;
  location_id: string | null;
  financial_account_id: string | null;
  transaction_type: string;
  transaction_number: string;
  transaction_date: string;
  partner_id: string | null;
  notes: string | null;
  grand_total: string;
  workflow_status: string;
  accounting_status: string;
  document_discount_amount: string;
};

type TxLine = {
  id: string;
  line_no: number;
  line_type: string;
  item_id: string | null;
  account_id: string | null;
  description: string | null;
  quantity: string;
  unit_id: string | null;
  dpp_amount: string;
  tax_amount: string;
  line_total: string;
  tax_code_id: string | null;
  location_id: string | null;
  cost_center_id: string | null;
  base_unit_id: string | null;
  track_stock: boolean | null;
  inventory_account_id: string | null;
  cogs_account_id: string | null;
  sales_account_id: string | null;
  usage_account_id: string | null;
  tax_type: string | null;
  input_tax_account_id: string | null;
  output_tax_account_id: string | null;
};

type JournalLinePlan = {
  accountId: string;
  debit: Decimal;
  credit: Decimal;
  description: string;
  locationId: string | null;
  costCenterId: string | null;
  partnerId: string | null;
  itemId: string | null;
  sourceLineId: string | null;
  metadata?: Record<string, unknown>;
};

function amount(value: string | number | null | undefined) {
  return new Decimal(value || 0);
}

function addPlanLine(lines: JournalLinePlan[], line: JournalLinePlan) {
  if (line.debit.eq(0) && line.credit.eq(0)) return;
  if (line.debit.lt(0) || line.credit.lt(0) || (line.debit.gt(0) && line.credit.gt(0))) {
    throw new Error('INVALID_JOURNAL_LINE');
  }
  lines.push(line);
}

async function loadHeader(client: PoolClient, transactionId: string) {
  const result = await client.query<TxHeader>(
    `SELECT id,workspace_id,company_id,location_id,financial_account_id,transaction_type,transaction_number,
            transaction_date::text,partner_id,notes,grand_total::text,workflow_status,accounting_status,
            document_discount_amount::text
       FROM transaction_headers
      WHERE id=$1
      FOR UPDATE`,
    [transactionId],
  );
  if (!result.rowCount) throw new Error('TRANSACTION_NOT_FOUND');
  return result.rows[0];
}

async function loadLines(client: PoolClient, tx: TxHeader) {
  const result = await client.query<TxLine>(
    `SELECT tl.id,tl.line_no,tl.line_type,tl.item_id,tl.account_id,tl.description,
            tl.quantity::text,tl.unit_id,tl.dpp_amount::text,tl.tax_amount::text,tl.line_total::text,
            tl.tax_code_id,tl.location_id,tl.cost_center_id,
            i.base_unit_id,i.track_stock,
            COALESCE(io.inventory_account_id,cm.inventory_account_id) inventory_account_id,
            COALESCE(io.cogs_account_id,cm.cogs_account_id) cogs_account_id,
            COALESCE(io.sales_account_id,cm.sales_account_id) sales_account_id,
            COALESCE(io.usage_account_id,cm.usage_account_id) usage_account_id,
            tc.tax_type,tc.input_tax_account_id,tc.output_tax_account_id
       FROM transaction_lines tl
       LEFT JOIN items i ON i.id=tl.item_id
       LEFT JOIN item_account_overrides io ON io.company_id=$2 AND io.item_id=tl.item_id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=$2 AND cm.category_id=i.category_id
       LEFT JOIN tax_codes tc ON tc.id=tl.tax_code_id
      WHERE tl.transaction_id=$1
      ORDER BY tl.line_no`,
    [tx.id, tx.company_id],
  );
  if (!result.rowCount) throw new Error('TRANSACTION_LINES_REQUIRED');
  return result.rows;
}

async function accountBelongsToCompany(client: PoolClient, accountId: string | null, companyId: string) {
  if (!accountId) return false;
  const result = await client.query('SELECT 1 FROM chart_of_accounts WHERE id=$1 AND company_id=$2 AND status=\'ACTIVE\'', [accountId, companyId]);
  return Boolean(result.rowCount);
}

async function loadImportantAccounts(client: PoolClient, companyId: string) {
  const result = await client.query<{ role_code: string; account_id: string }>(
    `SELECT role_code,account_id FROM important_accounts WHERE company_id=$1`, [companyId],
  );
  return new Map(result.rows.map(row => [row.role_code, row.account_id]));
}

async function loadTaxDefaults(client: PoolClient, companyId: string) {
  const result = await client.query<{ tax_role_code: string; account_id: string }>(
    `SELECT tax_role_code,account_id FROM tax_account_defaults WHERE company_id=$1`, [companyId],
  );
  return new Map(result.rows.map(row => [row.tax_role_code, row.account_id]));
}

async function resolveTaxAccount(
  client: PoolClient,
  tx: TxHeader,
  line: TxLine,
  side: 'INPUT' | 'OUTPUT',
  taxDefaults: Map<string, string>,
) {
  const direct = side === 'INPUT' ? line.input_tax_account_id : line.output_tax_account_id;
  if (await accountBelongsToCompany(client, direct, tx.company_id)) return direct!;
  if (line.tax_type === 'VAT') {
    const fallback = taxDefaults.get(side === 'INPUT' ? 'PPN_MASUKAN' : 'PPN_KELUARAN');
    if (fallback) return fallback;
  }
  throw new Error(`TAX_ACCOUNT_REQUIRED_LINE_${line.line_no}`);
}

async function resolveBaseQuantity(client: PoolClient, tx: TxHeader, line: TxLine) {
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

async function applyPurchaseInventory(
  client: PoolClient,
  tx: TxHeader,
  line: TxLine,
  userId: string,
) {
  if (!line.item_id || !line.track_stock) return;
  const locationId = line.location_id || tx.location_id;
  if (!locationId) throw new Error(`STOCK_LOCATION_REQUIRED_LINE_${line.line_no}`);
  const qtyBase = await resolveBaseQuantity(client, tx, line);
  const purchaseValue = amount(line.dpp_amount);
  if (purchaseValue.lt(0)) throw new Error(`INVALID_PURCHASE_VALUE_LINE_${line.line_no}`);

  await client.query(
    `INSERT INTO inventory_balances(workspace_id,company_id,location_id,item_id)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(company_id,location_id,item_id) DO NOTHING`,
    [tx.workspace_id, tx.company_id, locationId, line.item_id],
  );
  const balance = await client.query<{ quantity_on_hand: string; average_cost: string }>(
    `SELECT quantity_on_hand::text,average_cost::text
       FROM inventory_balances
      WHERE company_id=$1 AND location_id=$2 AND item_id=$3
      FOR UPDATE`,
    [tx.company_id, locationId, line.item_id],
  );
  const oldQty = amount(balance.rows[0]?.quantity_on_hand);
  const oldAvg = amount(balance.rows[0]?.average_cost);
  const newQty = oldQty.add(qtyBase);
  const oldValue = oldQty.mul(oldAvg);
  const newAvg = newQty.eq(0) ? new Decimal(0) : oldValue.add(purchaseValue).div(newQty);
  const unitCost = qtyBase.eq(0) ? new Decimal(0) : purchaseValue.div(qtyBase);

  await client.query(
    `UPDATE inventory_balances
        SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
      WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
    [newQty.toFixed(6), newAvg.toFixed(6), tx.company_id, locationId, line.item_id],
  );
  await client.query(
    `INSERT INTO inventory_movements(
       workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
       movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
     VALUES($1,$2,$3,$4,$5,$6,'PURCHASE_IN',$7,$8,$9,$10,$11,$12)
     ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
    [tx.workspace_id, tx.company_id, locationId, line.item_id, tx.id, line.id,
     qtyBase.toFixed(6), unitCost.toFixed(6), purchaseValue.toFixed(4), newQty.toFixed(6), newAvg.toFixed(6), userId],
  );
}

async function applyStockUsage(
  client: PoolClient,
  tx: TxHeader,
  line: TxLine,
  userId: string,
) {
  if (!line.item_id || !line.track_stock) throw new Error(`STOCK_ITEM_REQUIRED_LINE_${line.line_no}`);
  const locationId = line.location_id || tx.location_id;
  if (!locationId) throw new Error(`STOCK_LOCATION_REQUIRED_LINE_${line.line_no}`);
  if (!line.inventory_account_id) throw new Error(`INVENTORY_ACCOUNT_REQUIRED_LINE_${line.line_no}`);
  const usageAccountId = line.usage_account_id || line.cogs_account_id;
  if (!usageAccountId) throw new Error(`USAGE_ACCOUNT_REQUIRED_LINE_${line.line_no}`);

  const qtyBase = await resolveBaseQuantity(client, tx, line);
  const balance = await client.query<{ quantity_on_hand: string; average_cost: string }>(
    `SELECT quantity_on_hand::text,average_cost::text
       FROM inventory_balances
      WHERE company_id=$1 AND location_id=$2 AND item_id=$3
      FOR UPDATE`,
    [tx.company_id, locationId, line.item_id],
  );
  if (!balance.rowCount) throw new Error(`STOCK_BALANCE_NOT_FOUND_LINE_${line.line_no}`);
  const oldQty = amount(balance.rows[0].quantity_on_hand);
  const avgCost = amount(balance.rows[0].average_cost);
  if (oldQty.lt(qtyBase)) throw new Error(`INSUFFICIENT_STOCK_LINE_${line.line_no}`);
  const newQty = oldQty.sub(qtyBase);
  const newAvg = newQty.eq(0) ? new Decimal(0) : avgCost;
  const usageValue = qtyBase.mul(avgCost);
  const enteredQty = amount(line.quantity);
  const displayedUnitCost = enteredQty.eq(0) ? new Decimal(0) : usageValue.div(enteredQty);

  await client.query(
    `UPDATE inventory_balances
        SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW()
      WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
    [newQty.toFixed(6), newAvg.toFixed(6), tx.company_id, locationId, line.item_id],
  );
  await client.query(
    `INSERT INTO inventory_movements(
       workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
       movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
     VALUES($1,$2,$3,$4,$5,$6,'USAGE_OUT',$7,$8,$9,$10,$11,$12)
     ON CONFLICT(source_transaction_line_id,movement_type) DO NOTHING`,
    [tx.workspace_id, tx.company_id, locationId, line.item_id, tx.id, line.id,
     qtyBase.toFixed(6), avgCost.toFixed(6), usageValue.toFixed(4), newQty.toFixed(6), newAvg.toFixed(6), userId],
  );
  await client.query(
    `UPDATE transaction_lines
        SET unit_price=$1,gross_amount=$2,discount_type=NULL,discount_percent=0,discount_amount=0,
            document_discount_alloc=0,tax_code_id=NULL,tax_rate=0,tax_included=FALSE,
            dpp_amount=$2,tax_amount=0,line_total=$2
      WHERE id=$3`,
    [displayedUnitCost.toFixed(4), usageValue.toFixed(4), line.id],
  );

  return { usageValue, usageAccountId, inventoryAccountId: line.inventory_account_id, locationId };
}

async function buildPlan(client: PoolClient, tx: TxHeader, userId: string) {
  const txLines = await loadLines(client, tx);
  const important = await loadImportantAccounts(client, tx.company_id);
  const taxDefaults = await loadTaxDefaults(client, tx.company_id);
  const lines: JournalLinePlan[] = [];

  if (tx.transaction_type === 'PURCHASE_INVOICE') {
    let purchaseCreditAccount: string;
    let purchaseCreditLabel: string;
    let purchasePaymentType: 'CASH' | 'CREDIT';

    if (tx.financial_account_id) {
      const financial = await client.query<{ coa_account_id: string }>(
        `SELECT coa_account_id FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,
        [tx.financial_account_id, tx.company_id],
      );
      if (!financial.rowCount) throw new Error('INVALID_FINANCIAL_ACCOUNT');
      purchaseCreditAccount = financial.rows[0].coa_account_id;
      purchaseCreditLabel = 'Pembelian tunai';
      purchasePaymentType = 'CASH';
    } else {
      const payable = important.get('TRADE_PAYABLE');
      if (!payable) throw new Error('IMPORTANT_ACCOUNT_TRADE_PAYABLE_REQUIRED');
      purchaseCreditAccount = payable;
      purchaseCreditLabel = 'Utang usaha';
      purchasePaymentType = 'CREDIT';
    }

    for (const line of txLines) {
      const debitAccount = line.line_type === 'ITEM' ? line.inventory_account_id : line.account_id;
      if (!debitAccount) throw new Error(`PURCHASE_ACCOUNT_REQUIRED_LINE_${line.line_no}`);
      addPlanLine(lines, {
        accountId: debitAccount, debit: amount(line.dpp_amount), credit: new Decimal(0),
        description: line.description || `Pembelian ${tx.transaction_number}`,
        locationId: line.location_id || tx.location_id, costCenterId: line.cost_center_id,
        partnerId: tx.partner_id, itemId: line.item_id, sourceLineId: line.id,
        metadata: { paymentType: purchasePaymentType },
      });
      if (amount(line.tax_amount).gt(0)) {
        const taxAccount = await resolveTaxAccount(client, tx, line, 'INPUT', taxDefaults);
        addPlanLine(lines, {
          accountId: taxAccount, debit: amount(line.tax_amount), credit: new Decimal(0),
          description: `Pajak masukan ${tx.transaction_number}`,
          locationId: line.location_id || tx.location_id, costCenterId: line.cost_center_id,
          partnerId: tx.partner_id, itemId: line.item_id, sourceLineId: line.id,
          metadata: { paymentType: purchasePaymentType },
        });
      }
      await applyPurchaseInventory(client, tx, line, userId);
    }
    addPlanLine(lines, {
      accountId: purchaseCreditAccount, debit: new Decimal(0), credit: amount(tx.grand_total),
      description: `${purchaseCreditLabel} ${tx.transaction_number}`,
      locationId: tx.location_id, costCenterId: null, partnerId: tx.partner_id, itemId: null, sourceLineId: null,
      metadata: { paymentType: purchasePaymentType },
    });
  } else if (tx.transaction_type === 'CASH_OUT' || tx.transaction_type === 'CASH_IN') {
    if (!tx.financial_account_id) throw new Error('FINANCIAL_ACCOUNT_REQUIRED');
    const financial = await client.query<{ coa_account_id: string }>(
      `SELECT coa_account_id FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,
      [tx.financial_account_id, tx.company_id],
    );
    if (!financial.rowCount) throw new Error('INVALID_FINANCIAL_ACCOUNT');
    const financialCoa = financial.rows[0].coa_account_id;

    for (const line of txLines) {
      const baseAccount = line.line_type === 'ITEM'
        ? (tx.transaction_type === 'CASH_OUT' ? line.inventory_account_id : line.sales_account_id)
        : line.account_id;
      if (!baseAccount) throw new Error(`ACCOUNT_MAPPING_REQUIRED_LINE_${line.line_no}`);
      addPlanLine(lines, {
        accountId: baseAccount,
        debit: tx.transaction_type === 'CASH_OUT' ? amount(line.dpp_amount) : new Decimal(0),
        credit: tx.transaction_type === 'CASH_IN' ? amount(line.dpp_amount) : new Decimal(0),
        description: line.description || tx.transaction_number,
        locationId: line.location_id || tx.location_id, costCenterId: line.cost_center_id,
        partnerId: tx.partner_id, itemId: line.item_id, sourceLineId: line.id,
      });
      if (amount(line.tax_amount).gt(0)) {
        const side = tx.transaction_type === 'CASH_OUT' ? 'INPUT' : 'OUTPUT';
        const taxAccount = await resolveTaxAccount(client, tx, line, side, taxDefaults);
        addPlanLine(lines, {
          accountId: taxAccount,
          debit: side === 'INPUT' ? amount(line.tax_amount) : new Decimal(0),
          credit: side === 'OUTPUT' ? amount(line.tax_amount) : new Decimal(0),
          description: `${side === 'INPUT' ? 'Pajak masukan' : 'Pajak keluaran'} ${tx.transaction_number}`,
          locationId: line.location_id || tx.location_id, costCenterId: line.cost_center_id,
          partnerId: tx.partner_id, itemId: line.item_id, sourceLineId: line.id,
        });
      }
    }
    addPlanLine(lines, {
      accountId: financialCoa,
      debit: tx.transaction_type === 'CASH_IN' ? amount(tx.grand_total) : new Decimal(0),
      credit: tx.transaction_type === 'CASH_OUT' ? amount(tx.grand_total) : new Decimal(0),
      description: `${tx.transaction_type === 'CASH_OUT' ? 'Kas/Bank keluar' : 'Kas/Bank masuk'} ${tx.transaction_number}`,
      locationId: tx.location_id, costCenterId: null, partnerId: tx.partner_id, itemId: null, sourceLineId: null,
    });
  } else if (tx.transaction_type === 'STOCK_USAGE') {
    if (amount(tx.document_discount_amount).gt(0)) throw new Error('STOCK_USAGE_DISCOUNT_NOT_ALLOWED');
    let usageTotal = new Decimal(0);
    for (const line of txLines) {
      if (line.line_type !== 'ITEM') throw new Error(`STOCK_USAGE_ITEM_ONLY_LINE_${line.line_no}`);
      if (amount(line.tax_amount).gt(0) || line.tax_code_id) throw new Error(`STOCK_USAGE_TAX_NOT_ALLOWED_LINE_${line.line_no}`);
      const resolved = await applyStockUsage(client, tx, line, userId);
      if (!resolved) throw new Error(`STOCK_USAGE_RESOLUTION_FAILED_LINE_${line.line_no}`);
      usageTotal = usageTotal.add(resolved.usageValue);
      addPlanLine(lines, {
        accountId: resolved.usageAccountId, debit: resolved.usageValue, credit: new Decimal(0),
        description: line.description || `Pemakaian barang ${tx.transaction_number}`,
        locationId: resolved.locationId, costCenterId: line.cost_center_id,
        partnerId: null, itemId: line.item_id, sourceLineId: line.id,
        metadata: { costing: 'MOVING_AVERAGE' },
      });
      addPlanLine(lines, {
        accountId: resolved.inventoryAccountId, debit: new Decimal(0), credit: resolved.usageValue,
        description: line.description || `Persediaan keluar ${tx.transaction_number}`,
        locationId: resolved.locationId, costCenterId: line.cost_center_id,
        partnerId: null, itemId: line.item_id, sourceLineId: line.id,
        metadata: { costing: 'MOVING_AVERAGE' },
      });
    }
    await client.query(
      `UPDATE transaction_headers
          SET gross_amount=$1,line_discount_amount=0,document_discount_amount=0,dpp_amount=$1,tax_amount=0,grand_total=$1,updated_at=NOW()
        WHERE id=$2`,
      [usageTotal.toFixed(4), tx.id],
    );
    tx.grand_total = usageTotal.toFixed(4);
  } else {
    throw new Error(`AUTO_JOURNAL_NOT_SUPPORTED_${tx.transaction_type}`);
  }

  const debit = lines.reduce((sum, line) => sum.add(line.debit), new Decimal(0));
  const credit = lines.reduce((sum, line) => sum.add(line.credit), new Decimal(0));
  if (!debit.eq(credit)) throw new Error(`JOURNAL_NOT_BALANCED_${debit.toFixed(4)}_${credit.toFixed(4)}`);
  if (debit.eq(0)) throw new Error('ZERO_VALUE_JOURNAL_NOT_ALLOWED');
  return { lines, debit, credit };
}

async function readJournal(client: PoolClient, journalId: string) {
  const header = await client.query(
    `SELECT j.id,j.workspace_id,j.company_id,j.journal_number,j.journal_date,j.journal_type,j.status,j.description,
            j.source_transaction_id,j.engine_version,j.reviewed_at,j.posted_at,
            t.transaction_number source_transaction_number,t.transaction_type
       FROM journal_headers j
       LEFT JOIN transaction_headers t ON t.id=j.source_transaction_id
      WHERE j.id=$1`, [journalId],
  );
  const lines = await client.query(
    `SELECT jl.id,jl.line_no,jl.account_id,coa.code account_code,coa.name account_name,
            jl.debit::text,jl.credit::text,jl.description,jl.location_id,l.name location_name,
            jl.cost_center_id,cc.name cost_center_name,jl.partner_id,bp.name partner_name,
            jl.item_id,i.name item_name,jl.source_transaction_line_id,jl.metadata
       FROM journal_lines jl
       JOIN chart_of_accounts coa ON coa.id=jl.account_id
       LEFT JOIN locations l ON l.id=jl.location_id
       LEFT JOIN cost_centers cc ON cc.id=jl.cost_center_id
       LEFT JOIN business_partners bp ON bp.id=jl.partner_id
       LEFT JOIN items i ON i.id=jl.item_id
      WHERE jl.journal_id=$1
      ORDER BY jl.line_no`, [journalId],
  );
  return { ...header.rows[0], lines: lines.rows };
}

export async function verifyTransactionAndGenerateJournal(transactionId: string, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client, transactionId);

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM journal_headers WHERE source_transaction_id=$1 AND status<>'VOID' LIMIT 1`, [tx.id],
    );
    if (existing.rowCount) {
      const journal = await readJournal(client, existing.rows[0].id);
      await client.query('COMMIT');
      return journal;
    }
    if (tx.workflow_status !== 'DRAFT') throw new Error(`TRANSACTION_STATUS_MUST_BE_DRAFT_${tx.workflow_status}`);

    const plan = await buildPlan(client, tx, userId);
    const journalNumber = `AJ-${tx.transaction_number}`;
    const journal = await client.query<{ id: string }>(
      `INSERT INTO journal_headers(
         workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
       VALUES($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8)
       RETURNING id`,
      [tx.workspace_id, tx.company_id, journalNumber, tx.transaction_date,
       `AUTO_${tx.transaction_type}`, tx.id, `Auto journal ${tx.transaction_number}`, ENGINE_VERSION],
    );
    const journalId = journal.rows[0].id;

    for (let index = 0; index < plan.lines.length; index += 1) {
      const line = plan.lines[index];
      await client.query(
        `INSERT INTO journal_lines(
           journal_id,line_no,account_id,debit,credit,description,location_id,cost_center_id,partner_id,item_id,source_transaction_line_id,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [journalId, index + 1, line.accountId, line.debit.toFixed(4), line.credit.toFixed(4), line.description,
         line.locationId, line.costCenterId, line.partnerId, line.itemId, line.sourceLineId, JSON.stringify(line.metadata || {})],
      );
    }

    await client.query(
      `UPDATE transaction_headers
          SET workflow_status='FINANCE_VERIFIED',operational_status='FINANCE_VERIFIED',accounting_status='ACCOUNTING_REVIEW',
              verified_by=$1,verified_at=NOW(),updated_by=$1,updated_at=NOW()
        WHERE id=$2`,
      [userId, tx.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'FINANCE_VERIFY_AUTO_JOURNAL',$4::jsonb)`,
      [tx.workspace_id, userId, tx.id, JSON.stringify({ journalId, journalNumber, engineVersion: ENGINE_VERSION, debit: plan.debit.toFixed(4), credit: plan.credit.toFixed(4) })],
    );

    const result = await readJournal(client, journalId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
