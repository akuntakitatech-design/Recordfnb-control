-- Seed master awal (idempoten). Identitas contoh dapat diubah dari aplikasi.
INSERT IGNORE INTO legal_entities (id, code, name, address, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'YYS-HARAPAN', 'Yayasan Pendidikan Harapan', 'Pekanbaru, Riau', 'ACTIVE');

INSERT IGNORE INTO education_levels (id, legal_entity_id, code, name, sort_order)
VALUES
  ('22222222-2222-4222-8222-222222222221', '11111111-1111-4111-8111-111111111111', 'TK', 'Taman Kanak-kanak', 10),
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'SD', 'Sekolah Dasar', 20);

INSERT IGNORE INTO school_groups (id, legal_entity_id, education_level_id, code, name)
VALUES ('33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222221', 'TK-HARAPAN', 'TK Harapan');

INSERT IGNORE INTO official_schools (id, legal_entity_id, education_level_id, name, verification_status)
VALUES ('44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222221', 'TK Harapan', 'UNVERIFIED');

INSERT IGNORE INTO school_locations (id, legal_entity_id, name, address, city, province)
VALUES ('55555555-5555-4555-8555-555555555551', '11111111-1111-4111-8111-111111111111',
        'Panam', 'Jl. Panam, Pekanbaru', 'Pekanbaru', 'Riau');

INSERT IGNORE INTO academic_years (id, legal_entity_id, name, start_date, end_date)
VALUES ('66666666-6666-4666-8666-666666666661', '11111111-1111-4111-8111-111111111111',
        '2026/2027', '2026-07-01', '2027-06-30');

INSERT IGNORE INTO organization_units (
  id, legal_entity_id, education_level_id, school_group_id, official_school_id, location_id,
  unit_code, unit_name, short_name, unit_type, operational_status, finance_status,
  address, default_academic_year_id, effective_start
) VALUES (
  '77777777-7777-4777-8777-777777777771', '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221', '33333333-3333-4333-8333-333333333331',
  '44444444-4444-4444-8444-444444444441', '55555555-5555-4555-8555-555555555551',
  'TK-PANAM', 'TK Harapan Cabang Panam', 'TK Panam', 'SCHOOL_BRANCH', 'DRAFT', 'NOT_CONFIGURED',
  'Jl. Panam, Pekanbaru', '66666666-6666-4666-8666-666666666661', '2026-07-01'
);

INSERT IGNORE INTO unit_finance_settings (unit_id, account_mode)
VALUES ('77777777-7777-4777-8777-777777777771', 'MIXED');
