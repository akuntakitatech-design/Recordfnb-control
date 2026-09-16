import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

const ENGINE_VERSION = '0.14';
const money = (value: string | number | null | undefined) => new Decimal(value || 0);
const tolerance = new Decimal(1);

export type SalesIssue = {
  code: string;
  message: string;
  invoiceNumber?: string;
  rowNo?: number;
};

export type SalesShortage = {
  itemId: string;
  itemName: string;
  invoiceNumber: string;
  rowNo: number;
  available: string;
  requested: string;
  after: string;
  unitCode: string;
};

type Batch = {
  id: string;
  workspace_id: string;
  company_id: string;
  location_id: string;
  batch_number: string;
  status: string;
};

type Row = {
  id: string;
  row_no: number;
  sale_date: string;
  invoice_number: string;
  cashier: string | null;
  sale_type: string | null;
  item_code: string | null;
  item_name: string;
  item_id: string | null;
  quantity: string;
  unit_price: string;
  discount_amount: string;
  line_total: string;
  payment_cash: string;
  payment_qris: string;
  payment_transfer: string;
  payment_compliment: string;
  payment_gofood: string;
  payment_grabfood: string;
  can_sell: boolean | null;
  track_stock: boolean | null;
  base_unit_id: string | null;
  base_unit_code: string | null;
  inventory_account_id: string | null;
  cogs_account_id: string | null;
  sales_account_id: string | null;
};

type PaymentMapping = { payment_code: PaymentCode; account_id: string; label: string };
type PaymentCode = 'CASH' | 'QRIS' | 'TRANSFER' | 'COMPLIMENT' | 'GOFOOD' | 'GRABFOOD';
const paymentCodes: PaymentCode[] = ['CASH','QRIS','TRANSFER','COMPLIMENT','GOFOOD','GRABFOOD'];
const paymentField: Record<PaymentCode,keyof Row> = {
  CASH:'payment_cash', QRIS:'payment_qris', TRANSFER:'payment_transfer', COMPLIMENT:'payment_compliment',
  GOFOOD:'payment_gofood', GRABFOOD:'payment_grabfood',
};

export type SalesInvoicePreview = {
  key: string;
  saleDate: string;
  invoiceNumber: string;
  gross: string;
  discount: string;
  net: string;
  payments: Record<PaymentCode,string>;
  paymentTotal: string;
  rowCount: number;
};

export type SalesBatchPreview = {
  batchId: string;
  batchNumber: string;
  invoiceCount: number;
  rowCount: number;
  totalSales: string;
  totalPayments: string;
  issues: SalesIssue[];
  shortages: SalesShortage[];
  invoices: SalesInvoicePreview[];
};

async function loadBatch(client: PoolClient, batchId: string, lock = false) {
  const result = await client.query<Batch>(
    `SELECT id,workspace_id,company_id,location_id,batch_number,status
       FROM sales_import_batches
      WHERE id=$1
      ${lock ? 'FOR UPDATE' : ''}`,
    [batchId],
  );
  if (!result.rowCount) throw new Error('SALES_BATCH_NOT_FOUND');
  return result.rows[0];
}

async function loadRows(client: PoolClient, batch: Batch) {
  const result = await client.query<Row>(
    `SELECT r.id,r.row_no,r.sale_date::text,r.invoice_number,r.cashier,r.sale_type,r.item_code,r.item_name,r.item_id,
            r.quantity::text,r.unit_price::text,r.discount_amount::text,r.line_total::text,
            r.payment_cash::text,r.payment_qris::text,r.payment_transfer::text,r.payment_compliment::text,
            r.payment_gofood::text,r.payment_grabfood::text,
            i.can_sell,i.track_stock,i.base_unit_id,u.code base_unit_code,
            COALESCE(io.inventory_account_id,cm.inventory_account_id) inventory_account_id,
            COALESCE(io.cogs_account_id,cm.cogs_account_id) cogs_account_id,
            COALESCE(io.sales_account_id,cm.sales_account_id) sales_account_id
       FROM sales_import_rows r
       LEFT JOIN items i ON i.id=r.item_id AND i.workspace_id=$2 AND i.status='ACTIVE'
       LEFT JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN item_account_overrides io ON io.company_id=$3 AND io.item_id=i.id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=$3 AND cm.category_id=i.category_id
      WHERE r.batch_id=$1
      ORDER BY r.sale_date,r.invoice_number,r.row_no`,
    [batch.id,batch.workspace_id,batch.company_id],
  );
  if (!result.rowCount) throw new Error('SALES_ROWS_REQUIRED');
  return result.rows;
}

async function loadPaymentMappings(client: PoolClient, companyId: string) {
  const result = await client.query<PaymentMapping>(
    `SELECT payment_code,label,account_id
       FROM sales_payment_mappings
      WHERE company_id=$1`,
    [companyId],
  );
  return new Map(result.rows.map(row => [row.payment_code,row]));
}

async function loadSalesDiscountAccount(client: PoolClient, companyId: string) {
  const result = await client.query<{ account_id: string }>(
    `SELECT account_id FROM important_accounts WHERE company_id=$1 AND role_code='SALES_DISCOUNT' LIMIT 1`,
    [companyId],
  );
  return result.rows[0]?.account_id || null;
}

function groupInvoices(rows: Row[]) {
  const groups = new Map<string,Row[]>();
  for (const row of rows) {
    const key = `${row.sale_date}::${row.invoice_number}`;
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key,current);
  }
  return groups;
}

function resolveInvoicePayments(rows: Row[], invoiceNumber: string, issues: SalesIssue[]) {
  const payments = {} as Record<PaymentCode,Decimal>;
  for (const code of paymentCodes) {
    const values = rows
      .map(row => money(row[paymentField[code]] as string))
      .filter(value => value.gt(0));
    const distinct = [...new Set(values.map(value => value.toFixed(4)))];
    if (distinct.length > 1) {
      issues.push({
        code:'PAYMENT_VARIATION',
        invoiceNumber,
        message:`${invoiceNumber}: nilai ${code} berbeda antar baris. Isi pembayaran sekali per invoice atau gunakan nilai yang sama pada baris invoice tersebut.`,
      });
      payments[code] = new Decimal(0);
    } else {
      payments[code] = distinct.length ? new Decimal(distinct[0]) : new Decimal(0);
    }
  }
  return payments;
}

async function analyzeWithClient(client: PoolClient, batch: Batch, rows: Row[]): Promise<SalesBatchPreview> {
  const issues: SalesIssue[] = [];
  const shortages: SalesShortage[] = [];
  const invoices: SalesInvoicePreview[] = [];
  const paymentMappings = await loadPaymentMappings(client,batch.company_id);
  const salesDiscountAccount = await loadSalesDiscountAccount(client,batch.company_id);
  const groups = groupInvoices(rows);
  const virtualBalances = new Map<string,Decimal>();
  let totalSales = new Decimal(0);
  let totalPayments = new Decimal(0);

  for (const [key,invoiceRows] of groups.entries()) {
    const first = invoiceRows[0];
    const invoiceNumber = first.invoice_number;
    let invoiceGross = new Decimal(0);
    let invoiceDiscount = new Decimal(0);
    let invoiceNet = new Decimal(0);

    const duplicate = await client.query(
      `SELECT 1 FROM transaction_headers
        WHERE company_id=$1 AND location_id=$2 AND transaction_type='SALES_INVOICE'
          AND transaction_date=$3::date AND reference_number=$4
        LIMIT 1`,
      [batch.company_id,batch.location_id,first.sale_date,invoiceNumber],
    );
    if (duplicate.rowCount) {
      issues.push({ code:'DUPLICATE_INVOICE', invoiceNumber, message:`${invoiceNumber}: invoice penjualan sudah pernah diverifikasi.` });
    }

    for (const row of invoiceRows) {
      if (!row.item_id) {
        issues.push({ code:'ITEM_NOT_MAPPED', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: item ${row.item_code || row.item_name} belum dipetakan.` });
        continue;
      }
      if (!row.can_sell) {
        issues.push({ code:'ITEM_NOT_SELLABLE', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: ${row.item_name} belum ditandai Bisa Dijual pada master item.` });
      }
      if (!row.sales_account_id) {
        issues.push({ code:'SALES_ACCOUNT_REQUIRED', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: mapping akun penjualan kategori ${row.item_name} belum disiapkan Akuntakita.` });
      }

      const qty = money(row.quantity);
      const unitPrice = money(row.unit_price);
      const gross = qty.mul(unitPrice);
      const discount = money(row.discount_amount);
      const net = money(row.line_total);
      if (discount.gt(gross.plus(tolerance))) {
        issues.push({ code:'DISCOUNT_EXCEEDS_GROSS', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: diskon melebihi nilai penjualan.` });
      }
      if (net.sub(gross.sub(discount)).abs().gt(tolerance)) {
        issues.push({ code:'LINE_TOTAL_MISMATCH', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: TOTAL tidak sama dengan QTY × HARGA - DISKON.` });
      }
      invoiceGross = invoiceGross.add(gross);
      invoiceDiscount = invoiceDiscount.add(discount);
      invoiceNet = invoiceNet.add(net);

      if (row.track_stock) {
        if (!row.inventory_account_id || !row.cogs_account_id) {
          issues.push({ code:'COGS_MAPPING_REQUIRED', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: mapping Persediaan/HPP ${row.item_name} belum lengkap.` });
        }
        const itemKey = row.item_id;
        let available = virtualBalances.get(itemKey);
        if (available === undefined) {
          const balance = await client.query<{ quantity_on_hand: string; average_cost: string }>(
            `SELECT quantity_on_hand::text,average_cost::text
               FROM inventory_balances
              WHERE company_id=$1 AND location_id=$2 AND item_id=$3`,
            [batch.company_id,batch.location_id,row.item_id],
          );
          available = money(balance.rows[0]?.quantity_on_hand);
          if (money(balance.rows[0]?.average_cost).lte(0)) {
            issues.push({ code:'MOVING_AVERAGE_REQUIRED', invoiceNumber, rowNo:row.row_no, message:`Baris ${row.row_no}: HPP moving average ${row.item_name} belum tersedia di lokasi ini.` });
          }
        }
        const after = available.sub(qty);
        if (after.lt(0)) {
          shortages.push({
            itemId:row.item_id,
            itemName:row.item_name,
            invoiceNumber,
            rowNo:row.row_no,
            available:available.toFixed(6),
            requested:qty.toFixed(6),
            after:after.toFixed(6),
            unitCode:row.base_unit_code || '',
          });
        }
        virtualBalances.set(itemKey,after);
      }
    }

    if (invoiceDiscount.gt(0) && !salesDiscountAccount) {
      issues.push({ code:'SALES_DISCOUNT_ACCOUNT_REQUIRED', invoiceNumber, message:`${invoiceNumber}: akun Diskon Penjualan belum disiapkan Akuntakita.` });
    }

    const resolved = resolveInvoicePayments(invoiceRows,invoiceNumber,issues);
    let paymentTotal = new Decimal(0);
    for (const code of paymentCodes) {
      if (resolved[code].gt(0) && !paymentMappings.has(code)) {
        issues.push({ code:'PAYMENT_MAPPING_REQUIRED', invoiceNumber, message:`${invoiceNumber}: mapping pembayaran ${code} belum disiapkan Akuntakita.` });
      }
      paymentTotal = paymentTotal.add(resolved[code]);
    }
    if (paymentTotal.sub(invoiceNet).abs().gt(tolerance)) {
      issues.push({
        code:'PAYMENT_TOTAL_MISMATCH',
        invoiceNumber,
        message:`${invoiceNumber}: total pembayaran ${paymentTotal.toFixed(0)} tidak sama dengan total invoice ${invoiceNet.toFixed(0)}.`,
      });
    }

    invoices.push({
      key,
      saleDate:first.sale_date,
      invoiceNumber,
      gross:invoiceGross.toFixed(4),
      discount:invoiceDiscount.toFixed(4),
      net:invoiceNet.toFixed(4),
      payments:Object.fromEntries(paymentCodes.map(code => [code,resolved[code].toFixed(4)])) as Record<PaymentCode,string>,
      paymentTotal:paymentTotal.toFixed(4),
      rowCount:invoiceRows.length,
    });
    totalSales = totalSales.add(invoiceNet);
    totalPayments = totalPayments.add(paymentTotal);
  }

  return {
    batchId:batch.id,
    batchNumber:batch.batch_number,
    invoiceCount:groups.size,
    rowCount:rows.length,
    totalSales:totalSales.toFixed(4),
    totalPayments:totalPayments.toFixed(4),
    issues,
    shortages,
    invoices,
  };
}

export async function previewSalesBatch(batchId: string) {
  const client = await pool.connect();
  try {
    const batch = await loadBatch(client,batchId);
    const rows = await loadRows(client,batch);
    return await analyzeWithClient(client,batch,rows);
  } finally {
    client.release();
  }
}

async function nextSalesNumber(client: PoolClient, companyId: string, saleDate: string) {
  const year = Number(saleDate.slice(0,4));
  const result = await client.query<{ last_number: number }>(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'SALES_INVOICE',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId,year],
  );
  return `PJ-${year}-${String(result.rows[0].last_number).padStart(6,'0')}`;
}

export async function verifySalesBatch(batchId: string, userId: string, allowBelowZero = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await loadBatch(client,batchId,true);
    if (batch.status === 'FINANCE_VERIFIED') {
      const existing = await client.query<{ transaction_count: number }>(
        `SELECT COUNT(*)::int transaction_count FROM transaction_headers WHERE sales_import_batch_id=$1`,
        [batch.id],
      );
      await client.query('COMMIT');
      return { alreadyVerified:true, transactionCount:existing.rows[0]?.transaction_count || 0 };
    }
    if (batch.status !== 'DRAFT') throw new Error(`SALES_BATCH_STATUS_MUST_BE_DRAFT_${batch.status}`);

    const rows = await loadRows(client,batch);
    const preview = await analyzeWithClient(client,batch,rows);
    if (preview.issues.length) throw new Error(`SALES_BATCH_HAS_ISSUES:${preview.issues[0].message}`);
    if (preview.shortages.length && !allowBelowZero) throw new Error('INVENTORY_SHORTAGE_CONFIRMATION_REQUIRED');

    const paymentMappings = await loadPaymentMappings(client,batch.company_id);
    const salesDiscountAccount = await loadSalesDiscountAccount(client,batch.company_id);
    const groups = groupInvoices(rows);
    let transactionCount = 0;

    for (const invoiceRows of groups.values()) {
      const first = invoiceRows[0];
      const invoicePreview = preview.invoices.find(x => x.saleDate === first.sale_date && x.invoiceNumber === first.invoice_number);
      if (!invoicePreview) throw new Error('SALES_PREVIEW_INVOICE_NOT_FOUND');
      const transactionNumber = await nextSalesNumber(client,batch.company_id,first.sale_date);
      const header = await client.query<{ id: string }>(
        `INSERT INTO transaction_headers(
           workspace_id,company_id,location_id,transaction_type,transaction_number,transaction_date,reference_number,
           workflow_status,operational_status,accounting_status,payment_status,gross_amount,line_discount_amount,
           document_discount_amount,dpp_amount,tax_amount,grand_total,notes,created_by,updated_by,verified_by,verified_at,
           sales_import_batch_id)
         VALUES($1,$2,$3,'SALES_INVOICE',$4,$5,$6,
           'FINANCE_VERIFIED','FINANCE_VERIFIED','ACCOUNTING_REVIEW','PAID',$7,$8,0,$9,0,$9,$10,$11,$11,$11,NOW(),$12)
         RETURNING id`,
        [batch.workspace_id,batch.company_id,batch.location_id,transactionNumber,first.sale_date,first.invoice_number,
         invoicePreview.gross,invoicePreview.discount,invoicePreview.net,
         `Import ${batch.batch_number}${first.cashier ? ` · Cashier ${first.cashier}` : ''}`,userId,batch.id],
      );
      const transactionId = header.rows[0].id;
      const transactionLineIds = new Map<string,string>();

      for (let index=0; index<invoiceRows.length; index+=1) {
        const row = invoiceRows[index];
        if (!row.item_id || !row.base_unit_id) throw new Error(`ITEM_REQUIRED_ROW_${row.row_no}`);
        const gross = money(row.quantity).mul(money(row.unit_price));
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO transaction_lines(
             transaction_id,line_no,line_type,item_id,description,quantity,unit_id,unit_price,gross_amount,
             discount_type,discount_percent,discount_amount,document_discount_alloc,dpp_amount,tax_amount,line_total,
             location_id,metadata)
           VALUES($1,$2,'ITEM',$3,$4,$5,$6,$7,$8,$9,0,$10,0,$11,0,$11,$12,$13::jsonb)
           RETURNING id`,
          [transactionId,index+1,row.item_id,row.item_name,row.quantity,row.base_unit_id,row.unit_price,gross.toFixed(4),
           money(row.discount_amount).gt(0) ? 'AMOUNT' : null,row.discount_amount,row.line_total,batch.location_id,
           JSON.stringify({ salesImportRowId:row.id, cashier:row.cashier, saleType:row.sale_type, sourceItemCode:row.item_code })],
        );
        transactionLineIds.set(row.id,inserted.rows[0].id);
      }

      const journalNumber = `AJ-${transactionNumber}`;
      const journal = await client.query<{ id: string }>(
        `INSERT INTO journal_headers(
           workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
         VALUES($1,$2,$3,$4,'AUTO_SALES',$5,'DRAFT',$6,$7)
         RETURNING id`,
        [batch.workspace_id,batch.company_id,journalNumber,first.sale_date,transactionId,`Auto journal penjualan ${first.invoice_number}`,ENGINE_VERSION],
      );
      let journalLineNo = 1;

      for (const code of paymentCodes) {
        const value = money(invoicePreview.payments[code]);
        if (value.lte(0)) continue;
        const mapping = paymentMappings.get(code);
        if (!mapping) throw new Error(`PAYMENT_MAPPING_REQUIRED_${code}`);
        await client.query(
          `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,metadata)
           VALUES($1,$2,$3,$4,0,$5,$6,$7::jsonb)`,
          [journal.rows[0].id,journalLineNo++,mapping.account_id,value.toFixed(4),`${mapping.label} ${first.invoice_number}`,batch.location_id,
           JSON.stringify({ paymentCode:code, invoiceNumber:first.invoice_number })],
        );
      }

      if (money(invoicePreview.discount).gt(0)) {
        if (!salesDiscountAccount) throw new Error('SALES_DISCOUNT_ACCOUNT_REQUIRED');
        await client.query(
          `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,metadata)
           VALUES($1,$2,$3,$4,0,$5,$6,$7::jsonb)`,
          [journal.rows[0].id,journalLineNo++,salesDiscountAccount,invoicePreview.discount,`Diskon penjualan ${first.invoice_number}`,batch.location_id,
           JSON.stringify({ invoiceNumber:first.invoice_number })],
        );
      }

      for (const row of invoiceRows) {
        if (!row.item_id || !row.sales_account_id) throw new Error(`SALES_ACCOUNT_REQUIRED_ROW_${row.row_no}`);
        const sourceLineId = transactionLineIds.get(row.id)!;
        const gross = money(row.quantity).mul(money(row.unit_price));
        if (gross.gt(0)) {
          await client.query(
            `INSERT INTO journal_lines(
               journal_id,line_no,account_id,debit,credit,description,location_id,item_id,source_transaction_line_id,metadata)
             VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,$9::jsonb)`,
            [journal.rows[0].id,journalLineNo++,row.sales_account_id,gross.toFixed(4),row.item_name,batch.location_id,row.item_id,sourceLineId,
             JSON.stringify({ invoiceNumber:first.invoice_number, salesImportRowId:row.id })],
          );
        }

        if (row.track_stock) {
          if (!row.inventory_account_id || !row.cogs_account_id) throw new Error(`COGS_MAPPING_REQUIRED_ROW_${row.row_no}`);
          await client.query(
            `INSERT INTO inventory_balances(workspace_id,company_id,location_id,item_id)
             VALUES($1,$2,$3,$4)
             ON CONFLICT(company_id,location_id,item_id) DO NOTHING`,
            [batch.workspace_id,batch.company_id,batch.location_id,row.item_id],
          );
          const balance = await client.query<{ quantity_on_hand: string; average_cost: string }>(
            `SELECT quantity_on_hand::text,average_cost::text
               FROM inventory_balances
              WHERE company_id=$1 AND location_id=$2 AND item_id=$3
              FOR UPDATE`,
            [batch.company_id,batch.location_id,row.item_id],
          );
          const before = money(balance.rows[0]?.quantity_on_hand);
          const average = money(balance.rows[0]?.average_cost);
          const qty = money(row.quantity);
          const after = before.sub(qty);
          if (after.lt(0) && !allowBelowZero) throw new Error('INVENTORY_SHORTAGE_CONFIRMATION_REQUIRED');
          if (average.lte(0)) throw new Error(`MOVING_AVERAGE_REQUIRED_ROW_${row.row_no}`);
          const cogsValue = qty.mul(average);

          await client.query(
            `UPDATE inventory_balances SET quantity_on_hand=$1,updated_at=NOW()
              WHERE company_id=$2 AND location_id=$3 AND item_id=$4`,
            [after.toFixed(6),batch.company_id,batch.location_id,row.item_id],
          );
          await client.query(
            `INSERT INTO inventory_movements(
               workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
               movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
             VALUES($1,$2,$3,$4,$5,$6,'SALE_OUT',$7,$8,$9,$10,$8,$11)`,
            [batch.workspace_id,batch.company_id,batch.location_id,row.item_id,transactionId,sourceLineId,
             qty.toFixed(6),average.toFixed(6),cogsValue.toFixed(4),after.toFixed(6),userId],
          );
          if (cogsValue.gt(0)) {
            await client.query(
              `INSERT INTO journal_lines(
                 journal_id,line_no,account_id,debit,credit,description,location_id,item_id,source_transaction_line_id,metadata)
               VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9::jsonb)`,
              [journal.rows[0].id,journalLineNo++,row.cogs_account_id,cogsValue.toFixed(4),`HPP ${row.item_name}`,batch.location_id,row.item_id,sourceLineId,
               JSON.stringify({ costing:'MOVING_AVERAGE', averageCost:average.toFixed(6), quantityAfter:after.toFixed(6) })],
            );
            await client.query(
              `INSERT INTO journal_lines(
                 journal_id,line_no,account_id,debit,credit,description,location_id,item_id,source_transaction_line_id,metadata)
               VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,$9::jsonb)`,
              [journal.rows[0].id,journalLineNo++,row.inventory_account_id,cogsValue.toFixed(4),`Persediaan ${row.item_name}`,batch.location_id,row.item_id,sourceLineId,
               JSON.stringify({ costing:'MOVING_AVERAGE', averageCost:average.toFixed(6), quantityAfter:after.toFixed(6) })],
            );
          }
        }
      }

      await client.query(
        `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
         VALUES($1,$2,'TRANSACTION',$3,'FINANCE_VERIFY_SALES_INVOICE',$4::jsonb)`,
        [batch.workspace_id,userId,transactionId,JSON.stringify({ batchId:batch.id, batchNumber:batch.batch_number, invoiceNumber:first.invoice_number })],
      );
      transactionCount += 1;
    }

    await client.query(
      `UPDATE sales_import_batches
          SET status='FINANCE_VERIFIED',row_count=$1,invoice_count=$2,total_sales=$3,total_payments=$4,
              verified_by=$5,verified_at=NOW()
        WHERE id=$6`,
      [preview.rowCount,preview.invoiceCount,preview.totalSales,preview.totalPayments,userId,batch.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'SALES_IMPORT_BATCH',$3,'FINANCE_VERIFY_SALES_BATCH',$4::jsonb)`,
      [batch.workspace_id,userId,batch.id,JSON.stringify({ batchNumber:batch.batch_number, transactionCount, allowBelowZero, totalSales:preview.totalSales })],
    );

    await client.query('COMMIT');
    return { transactionCount, preview };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
