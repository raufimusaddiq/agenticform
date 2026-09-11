CREATE TABLE agent_messages (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    from_agent_id UUID NOT NULL REFERENCES agents(id),
    to_agent_id UUID NOT NULL REFERENCES agents(id),
    conversation_id UUID NOT NULL,
    reply_to_message_id UUID REFERENCES agent_messages(id),
    type VARCHAR(64) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    hop_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(64) NOT NULL,
    codex_queued_submission_id VARCHAR(255),
    codex_turn_id VARCHAR(255),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_agent_messages_project_id ON agent_messages(project_id);
CREATE INDEX idx_agent_messages_to_agent_status ON agent_messages(to_agent_id, status);
CREATE INDEX idx_agent_messages_conversation_id ON agent_messages(conversation_id);
