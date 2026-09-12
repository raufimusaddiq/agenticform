package com.agenticform.agent;

import com.agenticform.approval.HumanApprovalType;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.Locale;

@Component
public class AgentCapabilityPolicy {
    public AgentCapabilityProfile.Capability requiredForApproval(HumanApprovalType type, String action, JsonNode params) {
        if (type == HumanApprovalType.FILE_CHANGE) return AgentCapabilityProfile.Capability.WRITE;
        if (type == HumanApprovalType.PERMISSIONS) return AgentCapabilityProfile.Capability.WRITE;
        if (type == HumanApprovalType.USER_INPUT) return AgentCapabilityProfile.Capability.READ;
        if ("PRODUCTION_DEPLOY".equals(action)) return AgentCapabilityProfile.Capability.DEPLOY;
        if ("PRODUCTION_DML".equals(action) || "DELETE_DATA".equals(action)) {
            return AgentCapabilityProfile.Capability.WRITE;
        }
        if (type == HumanApprovalType.COMMAND_EXECUTION) return requiredForCommand(params);
        return requiredForSemanticAction(action);
    }

    public void require(AgentEntity agent, AgentCapabilityProfile.Capability capability) {
        if (!agent.getCapabilityProfile().allows(capability)) {
            throw new IllegalStateException("Agent capability profile " + agent.getCapabilityProfile()
                    + " does not allow " + capability);
        }
    }

    public boolean allows(AgentEntity agent, AgentCapabilityProfile.Capability capability) {
        return agent.getCapabilityProfile().allows(capability);
    }

    private AgentCapabilityProfile.Capability requiredForSemanticAction(String action) {
        if (action == null) return AgentCapabilityProfile.Capability.READ;
        String normalized = action.toUpperCase(Locale.ROOT);
        if (normalized.contains("DEPLOY") || normalized.contains("RELEASE") || normalized.contains("ROLLBACK")) {
            return AgentCapabilityProfile.Capability.DEPLOY;
        }
        if (normalized.contains("MERGE")) return AgentCapabilityProfile.Capability.MERGE;
        if (normalized.contains("COMMIT")) return AgentCapabilityProfile.Capability.COMMIT;
        if (normalized.contains("WRITE") || normalized.contains("DELETE") || normalized.contains("DML")
                || normalized.contains("MIGRATION")) {
            return AgentCapabilityProfile.Capability.WRITE;
        }
        if (normalized.contains("TEST") || normalized.contains("VERIFY")) {
            return AgentCapabilityProfile.Capability.TEST;
        }
        return AgentCapabilityProfile.Capability.READ;
    }

    private AgentCapabilityProfile.Capability requiredForCommand(JsonNode params) {
        String command = commandText(params).toLowerCase(Locale.ROOT).trim();
        if (command.isBlank()) return AgentCapabilityProfile.Capability.READ;
        if (command.matches(".*(^|\\s)git\\s+commit(\\s|$).*$")) return AgentCapabilityProfile.Capability.COMMIT;
        if (command.matches(".*(^|\\s)git\\s+(merge|rebase)(\\s|$).*$")) return AgentCapabilityProfile.Capability.MERGE;
        if (command.matches(".*(^|\\s)(mvn|./mvnw).*\\btest\\b.*")
                || command.matches(".*(^|\\s)(gradle|./gradlew).*\\btest\\b.*")
                || command.matches(".*(^|\\s)(npm|pnpm|yarn)\\s+(test|run\\s+test)(\\s|$).*")
                || command.matches(".*(^|\\s)go\\s+test(\\s|$).*")
                || command.matches(".*(^|\\s)(pytest|cargo\\s+test)(\\s|$).*") ) {
            return AgentCapabilityProfile.Capability.TEST;
        }
        if (looksMutating(command)) return AgentCapabilityProfile.Capability.WRITE;
        return AgentCapabilityProfile.Capability.READ;
    }

    private boolean looksMutating(String command) {
        return command.matches(".*(^|[;&|]\\s*|\\s)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|install)(\\s|$).*")
                || command.contains("sed -i")
                || command.matches(".*(^|\\s)git\\s+(add|restore|checkout|switch|reset|clean|apply|am)(\\s|$).*")
                || command.matches(".*(^|\\s)(npm|pnpm|yarn)\\s+(install|add|remove|uninstall)(\\s|$).*")
                || command.matches(".*(^|\\s)(pip|pip3)\\s+install(\\s|$).*")
                || command.matches(".*(^|\\s)(mvn|./mvnw)\\s+.*(package|install|deploy)(\\s|$).*")
                || command.matches(".*(^|\\s)(gradle|./gradlew)\\s+.*(build|assemble|publish)(\\s|$).*")
                || command.matches(".*(^|\\s)(docker|kubectl|helm|terraform|ansible-playbook)(\\s|$).*")
                || command.contains(">") || command.contains("tee ");
    }

    private String commandText(JsonNode params) {
        if (params == null || !params.hasNonNull("command")) return "";
        JsonNode command = params.get("command");
        return command.isTextual() ? command.asText() : command.toString();
    }
}
