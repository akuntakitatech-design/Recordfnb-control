/**
 * Mesin jurnal sederhana (ACC-01).
 *
 * Aturan:
 * - Setiap jurnal harus seimbang (debit = kredit) — ACC-02.
 * - Posting pada periode CLOSED ditolak — ACC-03.
 * - Akun harus ada, aktif, dan postable — ACC-01.
 * - Koreksi dilakukan dengan jurnal pembalik (reversal), bukan menimpa jurnal posted.
 * - Idempotency key mencegah jurnal ganda untuk satu sumber transaksi.
 */
import { randomUUID } from 'node:crypto';
import { fromCents, toCents, today } from './http.js';

const DEFAULT_RECEIVABLE = '1-1200';
const DEFAULT_CASH = '1-1100';
const DEFAULT_REVENUE = '4-1100';
const DEFAULT_DEPOSIT = '2-1200';

export type JournalLineInput = {
  accountCode: string;
  debitCents?: number;
  creditCents?: number;
  description?: string | null;
};

export type PostJournalInput = {
  legalEntityId: string;
  unitId?: string | null;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  idempotencyKey: string;
  lines: JournalLineInput[];
  createdBy?: string | null;
  entryKind?: 'ORIGINAL' | 'REVERSAL';
  reversalOf?: string | null;
};

export function journalError(code: string, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

async function q1(conn: any, sql: string, params: any[] = []): Promise<any> {
  const [rows]: any = await conn.query(sql, params);
  return rows?.[0] ?? null;
}

async function qAll(conn: any, sql: string, params: any[] = []): Promise<any[]> {
  const [rows]: any = await conn.query(sql, params);
  return rows || [];
}

/** Periode bulanan dibuat otomatis; periode yang sudah ditutup menolak posting. */
export async function ensurePeriod(conn: any, legalEntityId: string, dateOnly: string) {
  const month = dateOnly.slice(0, 7);
  const existing = await q1(conn, 'SELECT * FROM fiscal_periods WHERE legal_entity_id=? AND name=?', [legalEntityId, month]);
  if (existing) {
    if (existing.status === 'CLOSED') throw journalError('PERIOD_CLOSED', 409);
    return existing;
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const id = randomUUID();
  await conn.query(
    "INSERT INTO fiscal_periods(id,legal_entity_id,name,start_date,end_date,status) VALUES(?,?,?,?,?, 'OPEN')",
    [id, legalEntityId, month, `${month}-01`, `${month}-${String(lastDay).padStart(2, '0')}`],
  );
  return q1(conn, 'SELECT * FROM fiscal_periods WHERE id=?', [id]);
}

export async function postJournal(conn: any, input: PostJournalInput): Promise<string | null> {
  const lines = input.lines.filter(line => (line.debitCents || 0) > 0 || (line.creditCents || 0) > 0);
  if (!lines.length) return null;

  const debitTotal = lines.reduce((sum, line) => sum + (line.debitCents || 0), 0);
  const creditTotal = lines.reduce((sum, line) => sum + (line.creditCents || 0), 0);
  if (debitTotal !== creditTotal) throw journalError('JOURNAL_NOT_BALANCED', 409);

  const existing = await q1(
    conn, 'SELECT id FROM journal_entries WHERE legal_entity_id=? AND idempotency_key=?',
    [input.legalEntityId, input.idempotencyKey],
  );
  if (existing) return existing.id;

  const period = await ensurePeriod(conn, input.legalEntityId, input.entryDate);

  const codes = [...new Set(lines.map(line => line.accountCode))];
  const accounts = new Map<string, any>();
  for (const code of codes) {
    const account = await q1(
      conn, 'SELECT id,code,is_postable,status FROM accounts WHERE legal_entity_id=? AND code=?',
      [input.legalEntityId, code],
    );
    if (!account || account.status !== 'ACTIVE' || !account.is_postable) {
      throw journalError('ACCOUNT_MAPPING_MISSING', 400);
    }
    accounts.set(code, account);
  }

  const monthKey = input.entryDate.slice(0, 7).replace('-', '');
  const sequenceRow = await q1(
    conn, 'SELECT COUNT(*) total FROM journal_entries WHERE legal_entity_id=? AND entry_number LIKE ?',
    [input.legalEntityId, `JE-${monthKey}-%`],
  );
  const entryNumber = `JE-${monthKey}-${String(Number(sequenceRow?.total || 0) + 1).padStart(4, '0')}`;

  const id = randomUUID();
  await conn.query(
    `INSERT INTO journal_entries(id,legal_entity_id,unit_id,period_id,entry_number,entry_date,description,
       source_type,source_id,entry_kind,reversal_of,status,idempotency_key,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?, 'POSTED', ?,?)`,
    [id, input.legalEntityId, input.unitId || null, period.id, entryNumber, input.entryDate,
      input.description.slice(0, 255), input.sourceType, input.sourceId || null,
      input.entryKind || 'ORIGINAL', input.reversalOf || null, input.idempotencyKey, input.createdBy || null],
  );

  for (const [index, line] of lines.entries()) {
    await conn.query(
      `INSERT INTO journal_lines(id,entry_id,line_no,account_id,unit_id,description,debit,credit)
       VALUES(?,?,?,?,?,?,?,?)`,
      [randomUUID(), id, index + 1, accounts.get(line.accountCode)!.id, input.unitId || null,
        line.description || null, fromCents(line.debitCents || 0), fromCents(line.creditCents || 0)],
    );
  }
  return id;
}

/** Buat jurnal pembalik dari jurnal ORIGINAL yang masih POSTED. */
export async function reverseJournal(conn: any, input: {
  legalEntityId: string;
  sourceType?: string;
  sourceId?: string;
  originalId?: string;
  reason: string;
  userId?: string | null;
  entryDate?: string;
}): Promise<string | null> {
  const original = input.originalId
    ? await q1(conn, 'SELECT * FROM journal_entries WHERE id=? AND legal_entity_id=?', [input.originalId, input.legalEntityId])
    : await q1(
      conn,
      `SELECT * FROM journal_entries
        WHERE legal_entity_id=? AND source_type=? AND source_id=? AND entry_kind='ORIGINAL' AND status='POSTED'
        LIMIT 1`,
      [input.legalEntityId, input.sourceType, input.sourceId],
    );
  if (!original) return null;
  if (original.entry_kind !== 'ORIGINAL' || original.status !== 'POSTED') return null;

  const idempotencyKey = `REV:JE:${original.id}`;
  const existing = await q1(
    conn, 'SELECT id FROM journal_entries WHERE legal_entity_id=? AND idempotency_key=?',
    [input.legalEntityId, idempotencyKey],
  );
  if (existing) return existing.id;

  const lines = await qAll(
    conn,
    `SELECT a.code account_code,l.debit,l.credit,l.description
       FROM journal_lines l JOIN accounts a ON a.id=l.account_id
      WHERE l.entry_id=? ORDER BY l.line_no`,
    [original.id],
  );

  const id = await postJournal(conn, {
    legalEntityId: input.legalEntityId,
    unitId: original.unit_id,
    entryDate: input.entryDate || today(),
    description: `Pembalik ${original.entry_number}: ${input.reason}`,
    sourceType: input.sourceType || original.source_type,
    sourceId: input.sourceId || original.source_id,
    idempotencyKey,
    entryKind: 'REVERSAL',
    reversalOf: original.id,
    createdBy: input.userId || null,
    lines: lines.map(line => ({
      accountCode: line.account_code,
      debitCents: toCents(line.credit),
      creditCents: toCents(line.debit),
      description: line.description,
    })),
  });

  await conn.query("UPDATE journal_entries SET status='REVERSED' WHERE id=?", [original.id]);
  return id;
}

async function unitFinanceSettings(conn: any, unitId: string) {
  const settings = await q1(conn, 'SELECT * FROM unit_finance_settings WHERE unit_id=?', [unitId]);
  return {
    receivable: settings?.receivable_account_code || DEFAULT_RECEIVABLE,
    cash: settings?.cash_account_code || DEFAULT_CASH,
    revenue: settings?.revenue_account_code || DEFAULT_REVENUE,
  };
}

/** Akun kas/bank: mapping rekening fisik, lalu setting unit, lalu default CoA. */
export async function bankAccountCode(conn: any, legalEntityId: string, bankAccountId: string, unitId: string) {
  const account = await q1(
    conn, 'SELECT gl_account_code FROM bank_accounts WHERE id=? AND legal_entity_id=?',
    [bankAccountId, legalEntityId],
  );
  if (account?.gl_account_code) return account.gl_account_code;
  const settings = await unitFinanceSettings(conn, unitId);
  return settings.cash;
}

/** Tagihan: Dr Piutang, Cr Pendapatan per jenis biaya. */
export async function journalForInvoice(conn: any, invoiceId: string, userId?: string | null) {
  const invoice = await q1(
    conn,
    `SELECT i.id,i.legal_entity_id,i.unit_id,i.invoice_number,i.invoice_date,i.period_label
       FROM invoices i WHERE i.id=?`,
    [invoiceId],
  );
  if (!invoice) return null;

  const lines = await qAll(
    conn,
    `SELECT il.amount,ft.revenue_account_code,ft.name fee_name
       FROM invoice_lines il JOIN fee_types ft ON ft.id=il.fee_type_id
      WHERE il.invoice_id=? ORDER BY il.sort_order`,
    [invoiceId],
  );
  const settings = await unitFinanceSettings(conn, invoice.unit_id);
  const totalCents = lines.reduce((sum: number, line: any) => sum + toCents(line.amount), 0);
  if (totalCents <= 0) return null;

  return postJournal(conn, {
    legalEntityId: invoice.legal_entity_id,
    unitId: invoice.unit_id,
    entryDate: invoice.invoice_date,
    description: `Tagihan ${invoice.invoice_number} (${invoice.period_label})`,
    sourceType: 'INVOICE',
    sourceId: invoice.id,
    idempotencyKey: `INVOICE:${invoice.id}`,
    createdBy: userId || null,
    lines: [
      { accountCode: settings.receivable, debitCents: totalCents, description: `Piutang ${invoice.invoice_number}` },
      ...lines.map((line: any) => ({
        accountCode: line.revenue_account_code || settings.revenue,
        creditCents: toCents(line.amount),
        description: line.fee_name,
      })),
    ],
  });
}

/** Penerimaan: Dr Kas/Bank, Cr Piutang (teralokasi), Cr Uang Muka (belum dialokasikan). */
export async function journalForReceipt(conn: any, receiptId: string, userId?: string | null) {
  const receipt = await q1(
    conn,
    `SELECT r.id,r.legal_entity_id,r.unit_id,r.bank_account_id,r.receipt_number,r.receipt_date,
            r.total_amount,r.allocated_amount,r.unallocated_amount
       FROM receipts r WHERE r.id=?`,
    [receiptId],
  );
  if (!receipt) return null;

  const totalCents = toCents(receipt.total_amount);
  if (totalCents <= 0) return null;
  const allocatedCents = toCents(receipt.allocated_amount);
  const unallocatedCents = toCents(receipt.unallocated_amount);
  const settings = await unitFinanceSettings(conn, receipt.unit_id);
  const cashCode = await bankAccountCode(conn, receipt.legal_entity_id, receipt.bank_account_id, receipt.unit_id);

  return postJournal(conn, {
    legalEntityId: receipt.legal_entity_id,
    unitId: receipt.unit_id,
    entryDate: receipt.receipt_date,
    description: `Penerimaan ${receipt.receipt_number}`,
    sourceType: 'RECEIPT',
    sourceId: receipt.id,
    idempotencyKey: `RECEIPT:${receipt.id}`,
    createdBy: userId || null,
    lines: [
      { accountCode: cashCode, debitCents: totalCents, description: `Kas masuk ${receipt.receipt_number}` },
      ...(allocatedCents > 0
        ? [{ accountCode: settings.receivable, creditCents: allocatedCents, description: 'Pelunasan piutang' }]
        : []),
      ...(unallocatedCents > 0
        ? [{ accountCode: DEFAULT_DEPOSIT, creditCents: unallocatedCents, description: 'Uang muka belum dialokasikan' }]
        : []),
    ],
  });
}

/** Pembayaran pengeluaran: Dr Beban (akun jenis biaya), Cr Kas/Bank. */
export async function journalForExpensePayment(conn: any, paymentId: string, userId?: string | null) {
  const payment = await q1(
    conn,
    `SELECT p.id,p.legal_entity_id,p.unit_id,p.bank_account_id,p.payment_number,p.payment_date,p.amount,
            r.request_number,c.expense_account_code,c.name category_name
       FROM expense_payments p
       JOIN expense_requests r ON r.id=p.expense_request_id
       JOIN expense_categories c ON c.id=r.expense_category_id
      WHERE p.id=?`,
    [paymentId],
  );
  if (!payment) return null;

  const amountCents = toCents(payment.amount);
  if (amountCents <= 0) return null;
  const cashCode = await bankAccountCode(conn, payment.legal_entity_id, payment.bank_account_id, payment.unit_id);

  return postJournal(conn, {
    legalEntityId: payment.legal_entity_id,
    unitId: payment.unit_id,
    entryDate: payment.payment_date,
    description: `Pengeluaran ${payment.payment_number} (${payment.request_number})`,
    sourceType: 'EXPENSE_PAYMENT',
    sourceId: payment.id,
    idempotencyKey: `EXPENSE_PAYMENT:${payment.id}`,
    createdBy: userId || null,
    lines: [
      { accountCode: payment.expense_account_code, debitCents: amountCents, description: payment.category_name },
      { accountCode: cashCode, creditCents: amountCents, description: `Kas keluar ${payment.payment_number}` },
    ],
  });
}
