package com.agenticform.approval;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.HumanControlMode;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

@Component
public class HumanApprovalPolicy {
    private static final List<String> SAFE_COMMAND_PREFIXES = List.of(
            "git status",
            "git diff",
            "git log",
            "git show",
            "git branch --show-current",
            "mvn test",
            "./mvnw test",
            "gradle test",
            "./gradlew test",
            "npm test",
            "npm run test",
            "npm run build",
            "npm run lint",
            "pnpm test",
            "pnpm run test",
            "pnpm run build",
            "pnpm run lint",
            "yarn test",
            "yarn build",
            "yarn lint",
            "go test",
            "go vet",
            "cargo test"
    );

    public Evaluation evaluate(AgentEntity agent, HumanApprovalType type, JsonNode params) {
        HumanApprovalRisk risk = switch (type) {
            case COMMAND_EXECUTION -> commandRisk(agent, params);
            case FILE_CHANGE -> fileChangeRisk(agent, params);
            case PERMISSIONS -> HumanApprovalRisk.HIGH;
            case USER_INPUT -> HumanApprovalRisk.ELEVATED;
        };

        boolean autoApprove = agent.getHumanControlMode() == HumanControlMode.ON_THE_LOOP
                && risk == HumanApprovalRisk.LOW
                && type != HumanApprovalType.USER_INPUT;

        return new Evaluation(risk, autoApprove, summarize(type, params));
    }

    private HumanApprovalRisk commandRisk(AgentEntity agent, JsonNode params) {
        if (!isEmpty(params.path("networkApprovalContext"))
                || !isEmpty(params.path("proposedExecpolicyAmendment"))
                || !isEmpty(params.path("proposedNetworkPolicyAmendments"))) {
            return HumanApprovalRisk.HIGH;
        }

        String cwd = nullableText(params, "cwd");
        if (!isInsideWorkspace(agent, cwd)) {
            return HumanApprovalRisk.HIGH;
        }

        String command = nullableText(params, "command");
        if (command == null || !isSafeCommand(command)) {
            return HumanApprovalRisk.ELEVATED;
        }
        return HumanApprovalRisk.LOW;
    }

    private HumanApprovalRisk fileChangeRisk(AgentEntity agent, JsonNode params) {
        String grantRoot = nullableText(params, "grantRoot");
        if (grantRoot == null) {
            return HumanApprovalRisk.LOW;
        }
        return isInsideWorkspace(agent, grantRoot) ? HumanApprovalRisk.LOW : HumanApprovalRisk.HIGH;
    }

    private boolean isSafeCommand(String command) {
        String normalized = command.trim().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        if (normalized.contains(";") || normalized.contains("&&") || normalized.contains("||")
                || normalized.contains("|") || normalized.contains(">") || normalized.contains("<")
                || normalized.contains("`") || normalized.contains("$(")) {
            return false;
        }
        return SAFE_COMMAND_PREFIXES.stream().anyMatch(prefix ->
                normalized.equals(prefix) || normalized.startsWith(prefix + " "));
    }

    private boolean isInsideWorkspace(AgentEntity agent, String candidate) {
        try {
            Path workspace = Path.of(agent.getWorkingDirectory()).toAbsolutePath().normalize();
            Path target = candidate == null || candidate.isBlank()
                    ? workspace : Path.of(candidate).toAbsolutePath().normalize();
            return target.startsWith(workspace);
        } catch (RuntimeException invalidPath) {
            return false;
        }
    }

    private String summarize(HumanApprovalType type, JsonNode params) {
        return switch (type) {
            case COMMAND_EXECUTION -> firstNonBlank(
                    nullableText(params, "reason"), nullableText(params, "command"), "Command execution");
            case FILE_CHANGE -> firstNonBlank(
                    nullableText(params, "reason"), nullableText(params, "grantRoot"), "File change");
            case PERMISSIONS -> firstNonBlank(
                    nullableText(params, "reason"), "Additional permission request");
            case USER_INPUT -> {
                JsonNode questions = params.path("questions");
                if (questions.isArray() && !questions.isEmpty()) {
                    yield firstNonBlank(nullableText(questions.get(0), "question"), "Agent requested user input");
                }
                yield "Agent requested user input";
            }
        };
    }

    private boolean isEmpty(JsonNode node) {
        return node == null || node.isMissingNode() || node.isNull()
                || (node.isArray() && node.isEmpty()) || (node.isObject() && node.isEmpty());
    }

    private String nullableText(JsonNode node, String field) {
        if (node == null || !node.hasNonNull(field)) return null;
        String value = node.get(field).asText();
        return value == null || value.isBlank() ? null : value;
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value;
        }
        return "Approval required";
    }

    public record Evaluation(HumanApprovalRisk risk, boolean autoApprove, String summary) {}
}
