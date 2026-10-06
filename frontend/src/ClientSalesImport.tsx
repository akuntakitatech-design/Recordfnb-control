import { lazy, Suspense, useState } from 'react';

const ClientSalesImportPage = lazy(() => import('./ClientSalesImportPage'));
const ClientSalesImportProfiles = lazy(() => import('./ClientSalesImportProfiles').then(m => ({ default:m.ClientSalesImportProfiles })));

export function ClientSalesImport({ canVerify, canOverride, canImport = true }:{ canVerify:boolean; canOverride:boolean; canImport?:boolean }) {
  const [tab,setTab]=useState<'import'|'profiles'>('import');
  return <>
    <div className="page-content" style={{paddingBottom:0}}><section className="section-card" style={{padding:'12px 16px'}}><div className="table-toolbar"><div><button className={tab==='import'?'primary-button compact':'secondary-button compact'} onClick={()=>setTab('import')} data-testid="sales-tab-import">{canImport?'Import Penjualan':'Data Penjualan'}</button> {canImport&&<button className={tab==='profiles'?'primary-button compact':'secondary-button compact'} onClick={()=>setTab('profiles')} data-testid="sales-tab-profiles">Template POS</button>}</div><span>{!canImport?'Riwayat batch penjualan (import oleh Finance)':tab==='import'?'Upload / paste data transaksi':'Atur mapping format file POS'}</span></div></section></div>
    <Suspense fallback={<div className="page-content"><section className="section-card">Memuat modul Data Penjualan...</section></div>}>
      {tab==='import'||!canImport?<ClientSalesImportPage canVerify={canVerify} canOverride={canOverride} canImport={canImport}/>:<ClientSalesImportProfiles/>}
    </Suspense>
  </>;
}
