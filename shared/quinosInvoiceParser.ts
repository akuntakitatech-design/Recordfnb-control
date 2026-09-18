export type QuinosPaymentCode = 'CASH' | 'QRIS' | 'TRANSFER' | 'COMPLIMENT' | 'GOFOOD' | 'GRABFOOD';

export type QuinosSaleRow = {
  saleDate:string;
  invoiceNumber:string;
  cashier:string;
  saleType:string;
  itemCode:string;
  itemName:string;
  itemId:string;
  quantity:string;
  unitPrice:string;
  discountAmount:string;
  lineTotal:string;
  cash:string;
  qris:string;
  transfer:string;
  compliment:string;
  gofood:string;
  grabfood:string;
};

export type QuinosInvoiceAudit = {
  invoiceNumber:string;
  saleDate:string;
  itemRows:number;
  itemTotal:number;
  invoiceTotal:number|null;
  paymentTotal:number;
  paymentMethods:string[];
  difference:number|null;
};

export type QuinosParseResult = {
  provider:'QUINOS';
  reportType:'INVOICE_DETAIL';
  rows:QuinosSaleRow[];
  invoiceCount:number;
  warnings:string[];
  headerSignature:string[];
  audits:QuinosInvoiceAudit[];
};

const HEADER_SIGNATURE = ['Quinos Point Of Sale','Invoice Detail Report','Invoice #','Cashier','Type','Opened','Closed'];
const metadataLabels = new Set(['INVOICE','CASHIER','TYPE','PAX','OPENED','TBL','TABLE','CLOSED']);
const footerLabels = new Set(['SUBTOTAL','SERVICE','TAX','DISCOUNT','TOTAL','GRANDTOTAL','ROUNDING','CHANGE']);
const ignoredItemCodes = new Set(['OM000']);

const paymentAliases:Record<string,QuinosPaymentCode> = {
  CASH:'CASH',TUNAI:'CASH',
  QRIS:'QRIS',QRCODE:'QRIS',
  TRANSFER:'TRANSFER',BANKTRANSFER:'TRANSFER',
  COMPLIMENT:'COMPLIMENT',COMPLIMENTARY:'COMPLIMENT',
  GOFOOD:'GOFOOD',GOJEKFOOD:'GOFOOD',
  GRABFOOD:'GRABFOOD',
};

function text(value:unknown){
  if(value===null||value===undefined) return '';
  if(value instanceof Date) return value.toISOString();
  return String(value).trim();
}
function token(value:unknown){return text(value).toUpperCase().replace(/[^A-Z0-9]/g,'');}
function rowValues(row:unknown[]|undefined){return Array.isArray(row)?row.map(text):[];}
function nonEmpty(row:unknown[]|undefined){return rowValues(row).filter(Boolean);}

function parseNumber(value:unknown):number|null{
  let v=text(value).replace(/^Rp\s*/i,'').replace(/\s/g,'');
  if(!v) return null;
  if(!/^-?[\d.,]+$/.test(v)) return null;
  const negative=v.startsWith('-');
  if(negative) v=v.slice(1);
  let normalized=v;
  if(v.includes(',')&&v.includes('.')){
    const lastComma=v.lastIndexOf(',');
    const lastDot=v.lastIndexOf('.');
    normalized=lastDot>lastComma?v.replace(/,/g,''):v.replace(/\./g,'').replace(',','.');
  }else if(v.includes(',')){
    const parts=v.split(',');
    normalized=parts.length===2&&parts[1].length<=2?v.replace(',','.'):v.replace(/,/g,'');
  }else if(v.includes('.')){
    const parts=v.split('.');
    if(parts.length>2) normalized=v.replace(/\./g,'');
    else if(parts.length===2&&parts[1].length===3&&parts[0].length<=3) normalized=v.replace('.','');
  }
  const n=Number(normalized);
  return Number.isFinite(n)?(negative?-n:n):null;
}

function toIsoDate(value:unknown){
  const v=text(value);
  if(!v) return '';
  const iso=v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us=v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if(us){
    let year=Number(us[3]);
    if(year<100) year+=year>=70?1900:2000;
    const month=Number(us[1]);
    const day=Number(us[2]);
    if(month>=1&&month<=12&&day>=1&&day<=31) return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  const parsed=new Date(v);
  if(!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0,10);
  return '';
}

function looksLikeInvoice(value:unknown){return /^\d{5,10}$/.test(text(value));}
function looksLikeItemCode(value:unknown){
  const v=text(value).toUpperCase();
  if(!v||v.length>18||ignoredItemCodes.has(v)) return false;
  if(!/^[A-Z][A-Z0-9-]*$/.test(v)||!/[0-9]/.test(v)) return false;
  return !metadataLabels.has(token(v))&&!footerLabels.has(token(v))&&!paymentAliases[token(v)];
}
function looksLikeDescription(value:unknown){
  const v=text(value);
  const n=token(v);
  if(!v||parseNumber(v)!==null||looksLikeInvoice(v)||looksLikeItemCode(v)) return false;
  if(metadataLabels.has(n)||footerLabels.has(n)||paymentAliases[n]) return false;
  if(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/.test(v)) return false;
  return true;
}

function nearestNumber(row:unknown[],fromCol:number,direction:'left'|'right'){
  const step=direction==='left'?-1:1;
  for(let c=fromCol+step;c>=0&&c<row.length;c+=step){
    const n=parseNumber(row[c]);
    if(n!==null) return {col:c,value:n};
  }
  return null;
}
function numbersInRow(row:unknown[]){
  return row.map((value,col)=>({col,value:parseNumber(value)})).filter((x):x is {col:number;value:number}=>x.value!==null);
}
function nearestDescription(matrix:unknown[][],rowIndex:number,codeCol:number){
  const row=matrix[rowIndex]||[];
  for(let c=codeCol-1;c>=0;c-=1){if(looksLikeDescription(row[c])) return text(row[c]);}
  for(let r=rowIndex-1;r>=Math.max(0,rowIndex-2);r-=1){
    const prev=matrix[r]||[];
    for(let c=Math.min(codeCol,prev.length-1);c>=0;c-=1){if(looksLikeDescription(prev[c])) return text(prev[c]);}
  }
  return '';
}
function findNumericNearLabel(row:unknown[],labelCol:number){
  const right=nearestNumber(row,labelCol,'right');
  if(right) return right.value;
  const left=nearestNumber(row,labelCol,'left');
  return left?.value??null;
}
function firstBlockValue(matrix:unknown[][],start:number,end:number,col:number|undefined){
  if(col===undefined) return '';
  for(let r=start;r<end;r+=1){const v=text(matrix[r]?.[col]);if(v) return v;}
  return '';
}

export function isQuinosInvoiceReport(matrix:unknown[][]){
  const sample=matrix.slice(0,80).flatMap(nonEmpty).map(x=>x.toUpperCase()).join(' | ');
  return sample.includes('INVOICE DETAIL REPORT')&&(sample.includes('QUINOS')||sample.includes('INVOICE #'));
}

export function parseQuinosInvoiceReport(matrix:unknown[][]):QuinosParseResult{
  if(!isQuinosInvoiceReport(matrix)) throw new Error('QUINOS_INVOICE_DETAIL_NOT_DETECTED');
  const warnings:string[]=[];
  let invoiceCol:number|undefined;
  const metaCols:Record<string,number>={};

  for(let r=0;r<Math.min(matrix.length,100);r+=1){
    const row=matrix[r]||[];
    for(let c=0;c<row.length;c+=1){
      const n=token(row[c]);
      if(n==='INVOICE'&&invoiceCol===undefined) invoiceCol=c;
      if(['CASHIER','TYPE','PAX','OPENED','TBL','TABLE','CLOSED'].includes(n)&&metaCols[n]===undefined) metaCols[n]=c;
    }
  }

  const invoiceStarts:{row:number;invoiceNumber:string}[]=[];
  for(let r=0;r<matrix.length;r+=1){
    const row=matrix[r]||[];
    if(invoiceCol!==undefined&&looksLikeInvoice(row[invoiceCol])){
      invoiceStarts.push({row:r,invoiceNumber:text(row[invoiceCol])});
      continue;
    }
    if(invoiceCol===undefined){
      const candidate=row.slice(0,5).find(looksLikeInvoice);
      if(candidate) invoiceStarts.push({row:r,invoiceNumber:text(candidate)});
    }
  }
  if(!invoiceStarts.length) throw new Error('QUINOS_INVOICE_ROWS_NOT_FOUND');

  const rows:QuinosSaleRow[]=[];
  const audits:QuinosInvoiceAudit[]=[];

  for(let i=0;i<invoiceStarts.length;i+=1){
    const current=invoiceStarts[i];
    const end=i+1<invoiceStarts.length?invoiceStarts[i+1].row:matrix.length;
    const cashier=firstBlockValue(matrix,current.row,end,metaCols.CASHIER);
    const saleType=firstBlockValue(matrix,current.row,end,metaCols.TYPE);
    const opened=firstBlockValue(matrix,current.row,end,metaCols.OPENED);
    const closed=firstBlockValue(matrix,current.row,end,metaCols.CLOSED);
    const saleDate=toIsoDate(opened)||toIsoDate(closed);
    if(!saleDate) warnings.push(`${current.invoiceNumber}: tanggal Opened/Closed belum dapat dibaca.`);

    const invoiceRows:QuinosSaleRow[]=[];
    for(let r=current.row;r<end;r+=1){
      const row=matrix[r]||[];
      for(let c=0;c<row.length;c+=1){
        if(!looksLikeItemCode(row[c])) continue;
        const itemCode=text(row[c]).toUpperCase();
        const itemName=nearestDescription(matrix,r,c);
        if(!itemName) continue;
        const nums=numbersInRow(row).filter(x=>x.col!==invoiceCol&&x.col!==metaCols.PAX&&x.col!==metaCols.TBL&&x.col!==metaCols.TABLE);
        const rightNums=nums.filter(x=>x.col>c);
        const amountCandidate=rightNums.length?rightNums[rightNums.length-1]:nums.length?nums[nums.length-1]:null;
        const qtyCandidate=nums.filter(x=>x!==amountCandidate&&x.value>0&&x.value<=100&&Number.isInteger(x.value)).sort((a,b)=>Math.abs(a.col-c)-Math.abs(b.col-c))[0];
        const quantity=qtyCandidate?.value||1;
        const lineTotal=amountCandidate?.value??0;
        const unitPrice=quantity?lineTotal/quantity:lineTotal;
        invoiceRows.push({
          saleDate,invoiceNumber:current.invoiceNumber,cashier,saleType,itemCode,itemName,itemId:'',
          quantity:String(quantity),unitPrice:String(unitPrice),discountAmount:'0',lineTotal:String(lineTotal),
          cash:'0',qris:'0',transfer:'0',compliment:'0',gofood:'0',grabfood:'0',
        });
      }
    }

    let invoiceTotal:number|null=null;
    for(let r=current.row;r<end;r+=1){
      const row=matrix[r]||[];
      for(let c=0;c<row.length;c+=1){
        if(token(row[c])==='TOTAL'){
          const value=findNumericNearLabel(row,c);
          if(value!==null) invoiceTotal=value;
        }
      }
    }

    const paymentTotals:Partial<Record<QuinosPaymentCode,number>>={};
    const paymentMethods:string[]=[];
    for(let r=current.row;r<end;r+=1){
      const row=matrix[r]||[];
      for(let c=0;c<row.length;c+=1){
        if(c===metaCols.TYPE) continue;
        const code=paymentAliases[token(row[c])];
        if(!code) continue;
        if(!paymentMethods.includes(code)) paymentMethods.push(code);
        const direct=findNumericNearLabel(row,c);
        if(direct!==null&&(direct>0||invoiceTotal===0)) paymentTotals[code]=(paymentTotals[code]||0)+direct;
      }
    }
    if(paymentMethods.length===1&&(!paymentTotals[paymentMethods[0] as QuinosPaymentCode]||paymentTotals[paymentMethods[0] as QuinosPaymentCode]===0)&&invoiceTotal!==null){
      paymentTotals[paymentMethods[0] as QuinosPaymentCode]=invoiceTotal;
    }
    if(paymentMethods.length>1&&paymentMethods.some(code=>!paymentTotals[code as QuinosPaymentCode])) warnings.push(`${current.invoiceNumber}: split payment ditemukan tetapi sebagian nilai payment belum terbaca.`);
    if(!paymentMethods.length) warnings.push(`${current.invoiceNumber}: metode pembayaran belum terbaca.`);

    if(invoiceRows.length){
      const first=invoiceRows[0];
      const paymentField:Record<QuinosPaymentCode,keyof Pick<QuinosSaleRow,'cash'|'qris'|'transfer'|'compliment'|'gofood'|'grabfood'>>={
        CASH:'cash',QRIS:'qris',TRANSFER:'transfer',COMPLIMENT:'compliment',GOFOOD:'gofood',GRABFOOD:'grabfood',
      };
      for(const [code,value] of Object.entries(paymentTotals) as [QuinosPaymentCode,number][]){first[paymentField[code]]=String(value||0);}
      rows.push(...invoiceRows);
    }else{
      warnings.push(`${current.invoiceNumber}: tidak ada baris menu yang berhasil dikenali.`);
    }

    const itemTotal=invoiceRows.reduce((sum,row)=>sum+Number(row.lineTotal||0),0);
    const paymentTotal=Object.values(paymentTotals).reduce((sum,value)=>sum+(value||0),0);
    const difference=invoiceTotal===null?null:invoiceTotal-itemTotal;
    if(difference!==null&&Math.abs(difference)>1) warnings.push(`${current.invoiceNumber}: total item ${itemTotal.toFixed(0)} berbeda dengan total invoice ${invoiceTotal.toFixed(0)} sebesar ${difference.toFixed(0)}.`);
    audits.push({invoiceNumber:current.invoiceNumber,saleDate,itemRows:invoiceRows.length,itemTotal,invoiceTotal,paymentTotal,paymentMethods,difference});
  }

  return {provider:'QUINOS',reportType:'INVOICE_DETAIL',rows,invoiceCount:invoiceStarts.length,warnings,headerSignature:HEADER_SIGNATURE,audits};
}
