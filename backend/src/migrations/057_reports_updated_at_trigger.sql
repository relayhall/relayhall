-- Migration 057: DB-maintained updated_at on reports (task c655d243, item 2)
--
-- The app already sets updated_at on every ReportManager.update(); that stays
-- (harmless), but correctness no longer depends on it: any UPDATE — including
-- out-of-band psql fixes — now bumps updated_at at the database layer.
-- Reuses public.update_updated_at_column() from the baseline schema (same
-- function that backs the tasks/projects/sessions triggers). The function is
-- recreated defensively for databases initialized before the baseline dump.

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_reports_updated_at ON reports;

CREATE TRIGGER update_reports_updated_at
    BEFORE UPDATE ON reports
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
