-- Create "case_indices" table
CREATE TABLE "case_indices" ("case_id" uuid NOT NULL, "ancestor_id" uuid NOT NULL, "identifier" text NOT NULL, "relationship" text NOT NULL, "depth" integer NOT NULL, PRIMARY KEY ("case_id", "ancestor_id", "identifier"));
-- Create index "case_indices_ancestor_id_identifier_idx" to table: "case_indices"
CREATE INDEX "case_indices_ancestor_id_identifier_idx" ON "case_indices" ("ancestor_id", "identifier");
-- Create index "case_indices_case_id_identifier_idx" to table: "case_indices"
CREATE INDEX "case_indices_case_id_identifier_idx" ON "case_indices" ("case_id", "identifier");
-- Create "case_type_schemas" table
CREATE TABLE "case_type_schemas" ("app_id" text NOT NULL, "case_type" text NOT NULL, "schema" jsonb NOT NULL, PRIMARY KEY ("app_id", "case_type"));
-- Create "cases" table
CREATE TABLE "cases" ("case_id" uuid NOT NULL DEFAULT uuidv7(), "app_id" text NOT NULL, "case_type" text NOT NULL, "owner_id" text NULL, "status" text NULL, "opened_on" timestamptz NULL, "modified_on" timestamptz NULL, "closed_on" timestamptz NULL, "parent_case_id" uuid NULL, "properties" jsonb NOT NULL, PRIMARY KEY ("case_id"));
-- Create "cases_quarantine" table
CREATE TABLE "cases_quarantine" ("case_id" uuid NOT NULL, "app_id" text NOT NULL, "case_type" text NOT NULL, "owner_id" text NULL, "status" text NULL, "opened_on" timestamptz NULL, "modified_on" timestamptz NULL, "closed_on" timestamptz NULL, "parent_case_id" uuid NULL, "properties" jsonb NOT NULL, "quarantine_reason" text NOT NULL, "quarantined_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("case_id", "quarantined_at"));
