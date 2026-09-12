package com.agenticform.codex;

import com.agenticform.agent.AgentCapabilityProfile;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

@Component
public class CodexThreadConfiguration {
    private static final String GOVERNANCE = """
            You operate under Agenticform deterministic governance.
            Policy decisions are made by Agenticform, not by you. Never claim that an action is allowed, denied, or approved based on your own judgment.
            Use agenticform.list_policy_rules to inspect the rules applicable to your project/agent/task when governance is relevant.

            Agent communication is durable and routed through Agenticform. Use agenticform.send_message for direct communication and replies. Use agenticform.broadcast_message only when multiple agents genuinely need the same information or parallel request. Never broadcast acknowledgement-only messages, and do not reply-all by default. Recipients for multicast/role/group/project broadcast are resolved and snapshotted when the message is sent.

            Each active project may have one system-managed OPERATIONAL agent. If you are not that Operational Agent, hand off CI/CD, release, deployment, migration, backup, rollback, and operational verification intent through agenticform.handoff_to_operations. Do not directly request a registered operational runbook from a coding/reviewer/general role.
            If you are the Operational Agent, inspect agenticform.list_runbooks and use agenticform.request_operation for registered operations. request_operation evaluates policy itself, so do not call request_action separately for the same registered operation. Use agenticform.get_operation_status to inspect asynchronous progress and evidence.

            Operational signals and incidents are durable Agenticform state. Use list_incidents/get_incident/list_operational_signals to inspect current evidence rather than relying only on notification text. When responding to an incident, update it to INVESTIGATING or MITIGATING as work progresses and mark it RESOLVED only after evidence proves recovery. Incident diagnosis and coordination may be agentic; operational effects still go through request_operation and deterministic policy/runbooks.

            For coding tasks, prefer remote CI/CD backed by GitHub Actions for expensive full test/build/container/release/deploy work when such runbooks are available. You may still use local targeted tests and normal development commands when useful. Do not build production container images locally when an approved remote image-build workflow exists.
            General/non-coding work is not required to use GitHub Actions; choose the available tool or runbook that best matches the task.

            Before a governed semantic action that is not represented by a registered runbook, call agenticform.request_action with the exact action name, environment, summary, details, and when the action will be followed by a native command approval, an effectKey that exactly identifies that native effect. For command execution use the exact intended command plus cwd in the effectKey format described by the tool. If an exact effectKey cannot be produced, omit it and expect the native request to require a second human approval.
            The default policy requires a fresh human decision for PRODUCTION_DEPLOY in production, PRODUCTION_DML in production, DELETE_DATA in any environment, and genuine USER_INPUT.
            For backward compatibility, agenticform.request_protected_action is also available for PRODUCTION_DEPLOY, PRODUCTION_DML, and DELETE_DATA.
            Continue ordinary development autonomously when the deterministic policy result is ALLOW.
            A DENY result cannot be overridden. A human approval is valid only for the action/request that produced it unless Agenticform explicitly states otherwise.
            """;

    private final ObjectMapper mapper;

    public CodexThreadConfiguration(ObjectMapper mapper) { this.mapper = mapper; }

    public ObjectNode startParams(String cwd, String responsibility) {
        return startParams(cwd, responsibility, AgentCapabilityProfile.IMPLEMENTER);
    }

    public ObjectNode startParams(String cwd, String responsibility, AgentCapabilityProfile capabilityProfile) {
        AgentCapabilityProfile profile = capabilityProfile == null
                ? AgentCapabilityProfile.IMPLEMENTER : capabilityProfile;
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", cwd);
        params.put("baseInstructions", responsibility);
        params.put("developerInstructions", GOVERNANCE + "\nYour enforced Agenticform capability profile is "
                + profile.name() + " with capabilities " + profile.capabilities() + ". Do not attempt effects outside it.");
        params.put("approvalPolicy", "on-request");
        params.put("approvalsReviewer", "user");
        params.put("sandbox", profile.allows(AgentCapabilityProfile.Capability.WRITE)
                ? "workspace-write" : "read-only");
        params.set("dynamicTools", tools());
        return params;
    }

    public ArrayNode tools() {
        ArrayNode tools = mapper.createArrayNode();
        ObjectNode namespace = mapper.createObjectNode();
        namespace.put("type", "namespace");
        namespace.put("name", "agenticform");
        namespace.put("description", "Coordinate agents, inspect operational intelligence, communicate across a project, inspect deterministic policy, and request governed runbooks.");
        ArrayNode namespaceTools = namespace.putArray("tools");

        ObjectNode listAgents = function(namespaceTools, "list_agents",
                "List Agenticform agents in this project, including role, responsibility, system-managed state, execution node, and current status.");
        schema(listAgents).putObject("properties");

        ObjectNode sendMessage = function(namespaceTools, "send_message",
                "Send a durable direct asynchronous message to one Agenticform agent. Replies are direct by default. Do not send acknowledgement-only messages.");
        ObjectNode sendProps = schema(sendMessage).putObject("properties");
        property(sendProps, "targetAgentId", "string", "Agenticform agent UUID returned by list_agents.");
        messageType(sendProps);
        property(sendProps, "subject", "string", "Short message subject.");
        property(sendProps, "content", "string", "Message body with the minimum context the receiving agent needs.");
        property(sendProps, "replyToMessageId", "string", "Optional message UUID when replying to an incoming Agenticform message.");
        required(sendMessage, "targetAgentId", "type", "subject", "content");

        ObjectNode broadcast = function(namespaceTools, "broadcast_message",
                "Send one durable logical message to multiple same-project agents. Recipients are resolved and snapshotted when sent. Never use for acknowledgement-only fanout.");
        ObjectNode broadcastProps = schema(broadcast).putObject("properties");
        enumProperty(broadcastProps, "audienceType", "MULTICAST", "ROLE", "GROUP", "PROJECT_BROADCAST");
        ObjectNode agentIds = broadcastProps.putObject("agentIds");
        agentIds.put("type", "array");
        agentIds.putObject("items").put("type", "string");
        enumProperty(broadcastProps, "role", "GENERAL", "OPERATIONAL");
        property(broadcastProps, "groupId", "string", "Configured agent group UUID for GROUP audience.");
        messageType(broadcastProps);
        property(broadcastProps, "subject", "string", "Short subject shared by all recipients.");
        property(broadcastProps, "content", "string", "Message body with context needed by all recipients.");
        required(broadcast, "audienceType", "type", "subject", "content");

        ObjectNode handoff = function(namespaceTools, "handoff_to_operations",
                "Send a durable handoff/request/blocker directly to this project's default Operational Agent.");
        ObjectNode handoffProps = schema(handoff).putObject("properties");
        enumProperty(handoffProps, "type", "HANDOFF", "REQUEST", "BLOCKER");
        property(handoffProps, "subject", "string", "Short operational handoff subject.");
        property(handoffProps, "content", "string", "Minimum operational context, including candidate revision/PR/SHA and desired outcome when known.");
        required(handoff, "subject", "content");

        ObjectNode listPolicy = function(namespaceTools, "list_policy_rules",
                "List enabled deterministic policy rules applicable to this agent's current task, including scope, action, environment, effect, and precedence semantics.");
        schema(listPolicy).putObject("properties");

        ObjectNode listRunbooks = function(namespaceTools, "list_runbooks",
                "List enabled deterministic operational runbooks for this project. General agents may inspect them, but only the Operational Agent may request execution.");
        schema(listRunbooks).putObject("properties");

        ObjectNode operation = function(namespaceTools, "request_operation",
                "Operational-Agent-only: request execution of a registered deterministic runbook. Agenticform evaluates its policy action automatically.");
        ObjectNode operationProps = schema(operation).putObject("properties");
        property(operationProps, "runbookKey", "string", "Runbook key returned by list_runbooks.");
        ObjectNode parameters = operationProps.putObject("parameters");
        parameters.put("type", "object");
        ObjectNode parameterValue = mapper.createObjectNode();
        parameterValue.put("type", "string");
        parameters.set("additionalProperties", parameterValue);
        required(operation, "runbookKey");

        ObjectNode operationStatus = function(namespaceTools, "get_operation_status",
                "Read the current state and step summaries for a previously requested operation run in this project.");
        ObjectNode statusProps = schema(operationStatus).putObject("properties");
        property(statusProps, "runId", "string", "Operation run UUID returned by request_operation.");
        required(operationStatus, "runId");

        ObjectNode signalList = function(namespaceTools, "list_operational_signals",
                "List durable operational signals for this project. Use this to inspect raw deterministic evidence behind incidents.");
        ObjectNode signalProps = schema(signalList).putObject("properties");
        enumProperty(signalProps, "status", "OPEN", "CORRELATED", "RESOLVED", "SUPPRESSED");

        ObjectNode incidentList = function(namespaceTools, "list_incidents",
                "List operational incidents for this project, optionally filtered by lifecycle status.");
        ObjectNode incidentListProps = schema(incidentList).putObject("properties");
        enumProperty(incidentListProps, "status", "OPEN", "INVESTIGATING", "MITIGATING", "RESOLVED", "SUPPRESSED");

        ObjectNode incidentGet = function(namespaceTools, "get_incident",
                "Get one incident with correlated durable signals and evidence.");
        ObjectNode incidentGetProps = schema(incidentGet).putObject("properties");
        property(incidentGetProps, "incidentId", "string", "Operational incident UUID.");
        required(incidentGet, "incidentId");

        ObjectNode incidentUpdate = function(namespaceTools, "update_incident",
                "Operational-Agent-only: advance incident lifecycle. Mark RESOLVED only after evidence proves recovery.");
        ObjectNode incidentUpdateProps = schema(incidentUpdate).putObject("properties");
        property(incidentUpdateProps, "incidentId", "string", "Operational incident UUID.");
        enumProperty(incidentUpdateProps, "status", "INVESTIGATING", "MITIGATING", "RESOLVED", "SUPPRESSED");
        property(incidentUpdateProps, "summary", "string", "Investigation, mitigation, resolution, or suppression summary.");
        required(incidentUpdate, "incidentId", "status");

        ObjectNode requestAction = function(namespaceTools, "request_action",
                "Evaluate a semantic action through Agenticform's deterministic policy engine. Use for governed actions that do not already have a registered runbook.");
        ObjectNode actionProps = schema(requestAction).putObject("properties");
        property(actionProps, "action", "string", "Policy action name.");
        property(actionProps, "environment", "string", "Target environment such as production, staging, development, or *.");
        property(actionProps, "summary", "string", "Concise description of the exact action to evaluate.");
        property(actionProps, "details", "string", "Relevant target, command, resource, and scope for audit and human review.");
        property(actionProps, "effectKey", "string", "Optional exact native-effect key for one-shot preauthorization. For command execution use: command=<exact command>\\ncwd=<exact cwd or empty>\\nactions=<exact commandActions JSON or empty>. If uncertain, omit it so the native effect is approved separately.");
        required(requestAction, "action", "summary", "details");

        ObjectNode protectedAction = function(namespaceTools, "request_protected_action",
                "Compatibility helper for default protected actions. Prefer request_operation for registered runbooks and request_action for other configurable policy actions.");
        ObjectNode protectedProps = schema(protectedAction).putObject("properties");
        enumProperty(protectedProps, "kind", "PRODUCTION_DEPLOY", "PRODUCTION_DML", "DELETE_DATA");
        property(protectedProps, "environment", "string", "Target environment.");
        property(protectedProps, "summary", "string", "Concise description of the exact governed action.");
        property(protectedProps, "details", "string", "Relevant target/environment/command/data scope.");
        property(protectedProps, "effectKey", "string", "Optional exact native-effect key for one-shot preauthorization; omit when no exact native effect can be identified.");
        required(protectedAction, "kind", "summary", "details");

        tools.add(namespace);
        return tools;
    }

    private ObjectNode function(ArrayNode target, String name, String description) {
        ObjectNode tool = mapper.createObjectNode();
        tool.put("type", "function");
        tool.put("name", name);
        tool.put("description", description);
        target.add(tool);
        return tool;
    }

    private ObjectNode schema(ObjectNode tool) {
        ObjectNode schema = tool.putObject("inputSchema");
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        return schema;
    }

    private void required(ObjectNode tool, String... fields) {
        ArrayNode required = tool.path("inputSchema").withArray("required");
        for (String field : fields) required.add(field);
    }

    private void messageType(ObjectNode properties) {
        enumProperty(properties, "type", "QUESTION", "ANSWER", "REQUEST", "RESULT", "HANDOFF",
                "REVIEW_REQUEST", "REVIEW_RESULT", "INFORMATION", "BLOCKER");
    }

    private void enumProperty(ObjectNode properties, String name, String... values) {
        ObjectNode property = properties.putObject(name);
        property.put("type", "string");
        ArrayNode choices = property.putArray("enum");
        for (String value : values) choices.add(value);
    }

    private void property(ObjectNode properties, String name, String type, String description) {
        ObjectNode property = properties.putObject(name);
        property.put("type", type);
        property.put("description", description);
    }
}
