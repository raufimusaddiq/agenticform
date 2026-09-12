ALTER TABLE agents
    ADD COLUMN runtime_type VARCHAR(32) DEFAULT 'CODEX' NOT NULL,
    ADD COLUMN runtime_session_id VARCHAR(255);
