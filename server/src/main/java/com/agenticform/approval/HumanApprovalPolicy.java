package com.agenticform.approval;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.HumanControlMode;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.Locale;
import java.util.regex.Pattern;

@Component
public class HumanApprovalPolicy {
    private static final Pattern PRODUCTION_MARKER = Pattern.compile(
            "(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)|"
                    + "--(environment|env|stage|namespace)[=\\s]+(prod|production)|"
                    + "(^|\\s)-n\\s+(prod|production)(\\s|$)|"
                    + "node_env=(prod|production)|spring_profiles_active=(prod|production)");

    private static final Pattern DEPLOY_ACTION = Pattern.compile(
            "(^|\\s)(deploy|release)(\\s|$)|"
                    + "kubectl\\s+(apply|delete|rollout|set|patch)|"
                    + "helm\\s+(upgrade|install|uninstall|rollback)|"
                    + "terraform\\s+(apply|destroy)|"
                    + "ansible-playbook|argocd\\s+app\\s+sync|flux\\s+reconcile|"
                    + "gcloud\\s+run\\s+deploy|fly\\s+deploy|vercel.*--prod|"
                    + "serverless\\s+deploy|aws\\s+ecs\\s+update-service|"
                    + "docker\\s+compose.*\\s+up|systemctl\\s+(restart|start)|pm2\\s+(restart|reload)");

    private static final Pattern SQL_DML = Pattern.compile(
            "\\b(insert\\s+into|update\\s+[a-z0-9_.`\"]+\\s+set|merge\\s+into|replace\\s+into)\\b");

    private static final Pattern DATA_DELETE = Pattern.compile(
            "\\b(delete\\s+from|truncate(\\s+table)?|drop\\s+(table|database|schema|collection))\\b|"
                    + "redis-cli.*\\b(flushall|flushdb|del|unlink)\\b|"
                    + "mongosh?.*\\b(deleteone|deletemany|drop)\\b|"
                    + "curl.*(-x|--request)\\s+delete\\b|"
                    + "(^|\\s)http\\s+delete\\s+");

    public Evaluation evaluate(AgentEntity agent, HumanApprovalType type, JsonNode params) {
        HumanApprovalRisk risk = switch (type) {
            case COMMAND_EXECUTION -> protectedCommand(params) == null
                    ? HumanApprovalRisk.LOW : HumanApprovalRisk.HIGH;
            case FILE_CHANGE, PERMISSIONS -> HumanApprovalRisk.LOW;
            case USER_INPUT -> HumanApprovalRisk.ELEVATED;
            case PROTECTED_ACTION -> HumanApprovalRisk.HIGH;
        };

        boolean autoApprove = agent.getHumanControlMode() == HumanControlMode.ON_THE_LOOP
                && risk != HumanApprovalRisk.HIGH
                && type != HumanApprovalType.USER_INPUT;

        return new Evaluation(risk, autoApprove, summarize(type, params));
    }

    public ProtectedActionKind protectedCommand(JsonNode params) {
        String context = commandContext(params);
        if (context.isBlank()) {
            return null;
        }

        if (DATA_DELETE.matcher(context).find()) {
            return ProtectedActionKind.DELETE_DATA;
        }

        if (PRODUCTION_MARKER.matcher(context).find() && SQL_DML.matcher(context).find()) {
            return ProtectedActionKind.PRODUCTION_DML;
        }

        if (PRODUCTION_MARKER.matcher(context).find() && DEPLOY_ACTION.matcher(context).find()) {
            return ProtectedActionKind.PRODUCTION_DEPLOY;
        }

        return null;
    }

    private String commandContext(JsonNode params) {
        StringBuilder context = new StringBuilder();
        append(context, nullableText(params, "command"));
        append(context, nullableText(params, "reason"));
        append(context, nullableText(params, "cwd"));
        if (params != null && params.hasNonNull("commandActions")) {
            append(context, params.get("commandActions").toString());
        }
        if (params != null && params.hasNonNull("networkApprovalContext")) {
            append(context, params.get("networkApprovalContext").toString());
        }
        return context.toString().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim();
    }

    private void append(StringBuilder builder, String value) {
        if (value == null || value.isBlank()) return;
        if (!builder.isEmpty()) builder.append(' ');
        builder.append(value);
    }

    private String summarize(HumanApprovalType type, JsonNode params) {
        return switch (type) {
            case COMMAND_EXECUTION -> {
                ProtectedActionKind protectedAction = protectedCommand(params);
                if (protectedAction != null) {
                    yield "Protected action: " + protectedAction.name().toLowerCase(Locale.ROOT).replace('_', ' ');
                }
                yield firstNonBlank(nullableText(params, "reason"), nullableText(params, "command"), "Command execution");
            }
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
            case PROTECTED_ACTION -> firstNonBlank(
                    nullableText(params, "summary"), nullableText(params, "kind"), "Protected action");
        };
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
