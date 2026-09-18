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

test('parses the real Quinos printed report layout with labels and values in separate columns',()=>{
  const row=(values:Record<number,unknown>)=>{
    const r:Array<unknown>=Array(14).fill('');
    for(const [key,value] of Object.entries(values)) r[Number(key)]=value;
    return r;
  };
  const matrix=[
    row({1:'MEAT NIGHT'}),
    row({1:'INVOICE DETAIL REPORT'}),
    row({16:'Report time :',20:'Sunday 06 September 2026 9:57 PM'}),
    row({1:'Invoice #',4:'025158',11:'Cashier',13:'SALSA'}),
    row({1:'Type',4:'TAKE AWAY',6:'Pax',7:'1',11:'Opened',13:'9/1/26 5:08 PM'}),
    row({1:'TBL',11:'Closed',13:'9/1/26 5:08 PM'}),
    row({1:'2',4:'CHICKEN STEAK',10:'MN024',13:'96,000.00'}),
    row({1:'2',4:'MUSHROOM',10:'MN017',13:'0.00'}),
    row({1:'2',4:'MASHED POTATO',10:'MNS70',13:'0.00'}),
    row({1:'1',4:'CASH',13:'96,000.00'}),
    row({11:'Subtotal',13:'96,000.00'}),
    row({11:'Total',13:'96,000.00'}),
    row({1:'Invoice #',4:'025159',11:'Cashier',13:'SALSA'}),
    row({1:'Type',4:'TAKE AWAY',6:'Pax',7:'1',11:'Opened',13:'9/1/26 5:38 PM'}),
    row({1:'TBL',11:'Closed',13:'9/1/26 5:39 PM'}),
    row({1:'1',4:'CHICKEN STEAK',10:'MN024',13:'48,000.00'}),
    row({1:'1',4:'QRIS',13:'48,000.00'}),
    row({11:'Total',13:'48,000.00'}),
  ];
  const result=parseQuinosInvoiceReport(matrix);
  assert.equal(result.invoiceCount,2);
  assert.equal(result.rows.length,4);
  assert.equal(result.rows[0].invoiceNumber,'025158');
  assert.equal(result.rows[0].cashier,'SALSA');
  assert.equal(result.rows[0].saleType,'TAKE AWAY');
  assert.equal(result.rows[0].saleDate,'2026-09-01');
  assert.equal(result.rows[0].quantity,'2');
  assert.equal(result.rows[0].unitPrice,'48000');
  assert.equal(result.rows[0].cash,'96000');
  assert.equal(result.rows[3].invoiceNumber,'025159');
  assert.equal(result.rows[3].qris,'48000');
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
