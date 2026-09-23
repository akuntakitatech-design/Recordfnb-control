# CI
`ci.yml.example` adalah workflow GitHub Actions (typecheck + test backend, typecheck + build frontend).
Aktifkan dengan memindahkannya ke `.github/workflows/ci.yml` (PAT yang dipakai untuk PR ini tidak punya scope `workflow`,
sehingga file workflow tidak bisa dipush otomatis).
