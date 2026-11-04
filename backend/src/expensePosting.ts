import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { fromCents, toCents } from './http.js';
import { journalForExpensePayment } from './accounting.js';

/**
 * Hitung ulang paid_amount + status pengajuan dari pembayaran yang masih POSTED.
 * Status workflow tetap: APPROVED selama belum lunas, PAID bila sudah lunas.
 */
export async function refreshExpenseRequest(conn: any, requestId: string) {
  const [rows]: any = await conn.query(
    `SELECT r.amount,r.status,
            COALESCE((SELECT SUM(p.amount) FROM expense_payments p
                       WHERE p.expense_request_id=r.id AND p.status='POSTED'), 0) paid
       FROM expense_requests r WHERE r.id=?`,
    [requestId],
  );
  const row = rows[0];
  if (!row) return;
  const amountCents = toCents(row.amount);
  const paidCents = toCents(row.paid);
  const status = ['DRAFT', 'SUBMITTED', 'REJECTED', 'CANCELLED'].includes(row.status)
    ? row.status
    : (paidCents >= amountCents ? 'PAID' : 'APPROVED');
  await conn.query('UPDATE expense_requests SET paid_amount=?, status=? WHERE id=?', [
    fromCents(paidCents), status, requestId,
  ]);
}

export type PostExpensePaymentInput = {
  legalEntityId: string;
  unitId: string;
  unitCode: string | null;
  requestId: string;
  bankAccountId: string;
  paymentDate: string;
  method: string;
  referenceNumber?: string | null;
  amountCents: number;
  idempotencyKey?: string | null;
  notes?: string | null;
  userId: string;
};

/**
 * Posting pembayaran pengeluaran: insert pembayaran, mutasi kas keluar, hitung ulang
 * status pengajuan, lalu buat jurnal (Dr beban / Cr kas-bank). Satu transaksi.
 *
 * Dipakai oleh pembayaran langsung (`POST /expenses/{id}/payments`) dan oleh
 * posting MCM (`POST /payment-requests/{id}/post`).
 */
export async function postExpensePayment(input: PostExpensePaymentInput) {
  const id = randomUUID();
  const conn = await pool.getConnection();
  let paymentNumber = '';
  try {
    await conn.beginTransaction();
    const [rows]: any = await conn.query(
      'SELECT status,amount,paid_amount FROM expense_requests WHERE id=? FOR UPDATE',
      [input.requestId],
    );
    const locked = rows[0];
    if (!locked) throw Object.assign(new Error('EXPENSE_NOT_FOUND'), { statusCode: 404 });
    if (!['APPROVED', 'PAID'].includes(locked.status)) {
      throw Object.assign(new Error('EXPENSE_NOT_APPROVED'), { statusCode: 409 });
    }
    const remainingCents = toCents(locked.amount) - toCents(locked.paid_amount);
    if (input.amountCents > remainingCents) {
      throw Object.assign(new Error('PAYMENT_EXCEEDS_REMAINING'), { statusCode: 409 });
    }

    const unitCode = String(input.unitCode || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() || 'UNIT';
    const [seqRows]: any = await conn.query(
      'SELECT COUNT(*) total FROM expense_payments WHERE legal_entity_id=? AND payment_number LIKE ?',
      [input.legalEntityId, `PAY-${input.paymentDate.replace(/-/g, '')}-${unitCode}-%`],
    );
    paymentNumber = `PAY-${input.paymentDate.replace(/-/g, '')}-${unitCode}-${String(Number(seqRows[0].total) + 1).padStart(3, '0')}`;

    await conn.query(
      `INSERT INTO expense_payments(id,legal_entity_id,expense_request_id,unit_id,bank_account_id,payment_number,
         payment_date,method,reference_number,amount,status,idempotency_key,notes,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?, 'POSTED', ?,?,?)`,
      [id, input.legalEntityId, input.requestId, input.unitId, input.bankAccountId, paymentNumber,
        input.paymentDate, input.method, input.referenceNumber || null, fromCents(input.amountCents),
        input.idempotencyKey || null, input.notes || null, input.userId],
    );

    await conn.query(
      `INSERT INTO bank_mutations(id,legal_entity_id,bank_account_id,unit_id,mutation_date,direction,amount,source_type,source_id,description)
       VALUES(?,?,?,?,?, 'OUT', ?, 'EXPENSE', ?, ?)`,
      [randomUUID(), input.legalEntityId, input.bankAccountId, input.unitId, input.paymentDate,
        fromCents(input.amountCents), id, `Pengeluaran ${paymentNumber}`],
    );

    await refreshExpenseRequest(conn, input.requestId);

    // ACC-01: Dr Beban jenis biaya, Cr Kas/Bank.
    await journalForExpensePayment(conn, id, input.userId);

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { id, paymentNumber };
}
