ALTER TABLE node_runtime_snapshots
    ADD COLUMN runtime_type VARCHAR(32);

UPDATE node_runtime_snapshots
SET runtime_type = 'CODEX'
WHERE runtime_type IS NULL;

ALTER TABLE node_runtime_snapshots
    ALTER COLUMN runtime_type SET DEFAULT 'CODEX',
    ALTER COLUMN runtime_type SET NOT NULL;
