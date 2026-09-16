-- Repository-owned runbooks are discovered from a project manifest. Record the
-- exact source and commit so an operator can audit which revision declared the
-- deployment steps, and so a later sync can detect that the manifest changed.
ALTER TABLE operational_runbooks ADD COLUMN source VARCHAR(32);
ALTER TABLE operational_runbooks ADD COLUMN source_repository VARCHAR(256);
ALTER TABLE operational_runbooks ADD COLUMN source_commit VARCHAR(64);
ALTER TABLE operational_runbooks ADD COLUMN source_path VARCHAR(256);

-- Hand-registered runbooks keep NULL provenance; they are not repository-derived.
UPDATE operational_runbooks SET source = 'MANUAL' WHERE source IS NULL;

ALTER TABLE operational_runbooks ALTER COLUMN source SET DEFAULT 'MANUAL';
ALTER TABLE operational_runbooks ALTER COLUMN source SET NOT NULL;
