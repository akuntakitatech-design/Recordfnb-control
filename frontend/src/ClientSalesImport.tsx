import { lazy, Suspense, useState } from 'react';

const ClientSalesImportPage = lazy(() => import('./ClientSalesImportPage'));
const ClientSalesImportProfiles = lazy(() => import('./ClientSalesImportProfiles').then(m => ({ default:m.ClientSalesImportProfiles })));

export function ClientSalesImport({ canVerify, canOverride }:{ canVerify:boolean; canOverride:boolean }) {
  const [tab,setTab]=useState<'import'|'profiles'>('import');
  return <>
    <div className="page-content" style={{paddingBottom:0}}><section className="section-card" style={{padding:'12px 16px'}}><div className="table-toolbar"><div><button className={tab==='import'?'primary-button compact':'secondary-button compact'} onClick={()=>setTab('import')}>Import Penjualan</button> <button className={tab==='profiles'?'primary-button compact':'secondary-button compact'} onClick={()=>setTab('profiles')}>Template POS</button></div><span>{tab==='import'?'Upload / paste data transaksi':'Atur mapping format file POS'}</span></div></section></div>
    <Suspense fallback={<div className="page-content"><section className="section-card">Memuat modul Data Penjualan...</section></div>}>
      {tab==='import'?<ClientSalesImportPage canVerify={canVerify} canOverride={canOverride}/>:<ClientSalesImportProfiles/>}
    </Suspense>
  </>;
}
