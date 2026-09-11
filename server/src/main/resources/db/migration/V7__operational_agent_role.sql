ALTER TABLE agents
    ADD COLUMN agent_role varchar(32) NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN system_managed boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX ux_agents_project_operational_role
    ON agents(project_id)
    WHERE agent_role = 'OPERATIONAL';
