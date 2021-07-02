# PostgreSQL Analogue Tests

This pseudo-package contains a test suite for the basic features of PostgreSQL
that are commonly supported by PostgreSQL analogues such as CockroachDB which
are different database software but aim for PostgreSQL compatibility, at least
at the protocol level. Typically these analogues don't support PostgreSQL's
rich feature set, so these tests will not test these features (for tests that
do, see the `postgraphile-core` test suite).

Currently this suite is only used for CockroachDB and thus the following
limitations are applied:

- Significantly reduced set of built in types; no:
  - `hstore`
  - `cidr`
  - `macaddr`
  - `money`
  - geometry types: `point`, `line`, `lseg`, `box`, `path`, `polygon`, `circle`
  - `numrange`
  - `daterange`
  - `regoper`
  - `regoperator`
  - `regconfig`
  - `regdictionary`
- No custom composite types (`CREATE TYPE ... AS ( ... )`)
- No custom range types (`CREATE TYPE ... AS RANGE ( ... )`)
- No `CREATE DOMAIN`
- No `CREATE FUNCTION`
- No `CREATE TRIGGER`
- No `CREATE EXTENSION`
- No `CREATE TABLE ... ( ... ) INHERITS ( ... )`
- No `CREATE VIEW ... AS ( SELECT * FROM ... )`
- No `COMMENT ON SCHEMA`
- No `COMMENT ON CONSTRAINT`
- No `COMMENT ON VIEW`
- No `COMMENT ON COLUMN` on a view's column
- No `COMMENT ON TYPE`
- No `DO $$`
- No `CREATE ROLE ... NOINHERIT`
- No `CREATE INDEX` over expressions (columns only)
- No `ALTER DEFAULT PRIVILEGES`
- No `GRANT ... ON ALL SEQUENCES IN SCHEMA ...`
- No column-based grants (`GRANT SELECT (...), INSERT (...), UPDATE (...) ON ...`)
- No `SET LOCAL TIMEZONE TO ...`
- No `SET [LOCAL] ROLE ...`
- No `SELECT set_config(..., true)`
- No generated identity columns `... GENERATED ALWAYS AS IDENTITY ...`
- No `ALTER SEQUENCE ... RESTART WITH`
  - _In CockroachDB, `SERIAL` out of the box uses `unique_rowid()` rather than a sequence. This can be changed via session var `serial_normalization`.
