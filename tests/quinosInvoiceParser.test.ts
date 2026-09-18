import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuinosInvoiceReport, parseQuinosInvoiceReport } from '../shared/quinosInvoiceParser.js';

test('detects Quinos invoice detail report',()=>{
  const matrix=[
    ['Quinos Point Of Sale'],
    ['Invoice Detail Report'],
    ['Invoice #','Cashier','Type','Pax','Opened','TBL','Closed','','Item','Code','Qty','Amount'],
  ];
  assert.equal(isQuinosInvoiceReport(matrix),true);
});

test('parses invoice blocks, items and payment',()=>{
  const matrix=[
    ['Quinos Point Of Sale'],
    ['Invoice Detail Report'],
    ['Invoice #','Cashier','Type','Pax','Opened','TBL','Closed','','Item','Code','Qty','Amount'],
    ['025158','SALSA','TAKE AWAY','','9/1/26 5:08 PM','','9/1/26 5:20 PM','','CHICKEN STEAK','MN024',1,'96,000.00'],
    ['','','','','','','','','MUSHROOM','MN017',1,'0.00'],
    ['','','','','','','','','MASHED POTATO','MNS70',1,'0.00'],
    ['','','','','','','','','CASH','105,600.00'],
    ['','','','','','','','','Total','105,600.00'],
    ['025159','SALSA','DINE IN','','9/1/26 5:38 PM','18','9/1/26 5:39 PM','','SIRLOIN','MN003',2,'178,000.00'],
    ['','','','','','','','','QRIS','178,000.00'],
    ['','','','','','','','','Total','178,000.00'],
  ];
  const result=parseQuinosInvoiceReport(matrix);
  assert.equal(result.invoiceCount,2);
  assert.equal(result.rows.length,4);
  assert.equal(result.rows[0].invoiceNumber,'025158');
  assert.equal(result.rows[0].saleDate,'2026-09-01');
  assert.equal(result.rows[0].itemCode,'MN024');
  assert.equal(result.rows[0].cash,'105600');
  assert.equal(result.rows[3].quantity,'2');
  assert.equal(result.rows[3].unitPrice,'89000');
  assert.equal(result.rows[3].qris,'178000');
});

test('ignores Quinos order memo code OM000',()=>{
  const matrix=[
    ['Quinos Point Of Sale'],
    ['Invoice Detail Report'],
    ['Invoice #','Cashier','Type','Pax','Opened','TBL','Closed','','Item','Code','Qty','Amount'],
    ['025160','SALSA','DINE IN','','9/1/26 6:00 PM','12','9/1/26 6:10 PM','','SIRLOIN','MN003',1,89000],
    ['','','','','','','','','BELUM YA','OM000',1,0],
    ['','','','','','','','','CASH',89000],
    ['','','','','','','','','Total',89000],
  ];
  const result=parseQuinosInvoiceReport(matrix);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].itemCode,'MN003');
});
