-- Modify "cases" table
ALTER TABLE "cases" ADD CONSTRAINT "cases_case_name_check" CHECK (length(case_name) > 0), ADD COLUMN "case_name" text NOT NULL;
-- Modify "cases_quarantine" table
ALTER TABLE "cases_quarantine" ADD COLUMN "case_name" text NULL;
