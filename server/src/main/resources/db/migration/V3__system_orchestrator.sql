UPDATE agents
SET agent_role = 'ORCHESTRATOR', system_managed = TRUE, capability_profile = 'ORCHESTRATOR'
WHERE agent_role = 'GENERAL' AND capability_profile = 'ORCHESTRATOR';

CREATE UNIQUE INDEX ux_agents_project_orchestrator_role
    ON agents(project_id) WHERE agent_role = 'ORCHESTRATOR';
