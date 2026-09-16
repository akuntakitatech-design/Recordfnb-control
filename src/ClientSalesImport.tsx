import { lazy, Suspense } from 'react';

const ClientSalesImportPage = lazy(() => import('./ClientSalesImportPage'));

export function ClientSalesImport({ canVerify, canOverride }:{ canVerify:boolean; canOverride:boolean }) {
  return <Suspense fallback={<div className="page-content"><section className="section-card">Memuat modul Data Penjualan...</section></div>}>
    <ClientSalesImportPage canVerify={canVerify} canOverride={canOverride}/>
  </Suspense>;
}
