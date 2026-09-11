package com.agenticform.policy;

import com.agenticform.approval.HumanApprovalType;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.Locale;
import java.util.regex.Pattern;

@Component
public class PolicyActionClassifier {
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

    public ClassifiedAction classify(HumanApprovalType type, JsonNode params) {
        return switch (type) {
            case COMMAND_EXECUTION -> classifyCommand(params);
            case FILE_CHANGE -> new ClassifiedAction("FILE_CHANGE", environment(params), summary(params, "reason", "grantRoot", "File change"));
            case PERMISSIONS -> new ClassifiedAction("PERMISSIONS", environment(params), summary(params, "reason", null, "Additional permission request"));
            case USER_INPUT -> new ClassifiedAction("USER_INPUT", "*", userInputSummary(params));
            case PROTECTED_ACTION -> semanticAction(text(params, "kind"), text(params, "environment"),
                    summary(params, "summary", "kind", "Protected action"));
        };
    }

    public ClassifiedAction declaredAction(JsonNode arguments) {
        return semanticAction(text(arguments, "action"), text(arguments, "environment"),
                summary(arguments, "summary", "action", "Policy-governed action"));
    }

    private ClassifiedAction semanticAction(String rawAction, String rawEnvironment, String summary) {
        String action = normalizeAction(rawAction);
        String environment = normalizeEnvironment(rawEnvironment);
        if ("*".equals(environment)
                && ("PRODUCTION_DEPLOY".equals(action) || "PRODUCTION_DML".equals(action))) {
            environment = "production";
        }
        return new ClassifiedAction(action, environment, summary);
    }

    private ClassifiedAction classifyCommand(JsonNode params) {
        String context = commandContext(params);
        String environment = PRODUCTION_MARKER.matcher(context).find() ? "production" : environment(params);
        if (DATA_DELETE.matcher(context).find()) {
            return new ClassifiedAction("DELETE_DATA", environment, "Detected destructive data operation");
        }
        if ("production".equals(environment) && SQL_DML.matcher(context).find()) {
            return new ClassifiedAction("PRODUCTION_DML", "production", "Detected production data mutation");
        }
        if ("production".equals(environment) && DEPLOY_ACTION.matcher(context).find()) {
            return new ClassifiedAction("PRODUCTION_DEPLOY", "production", "Detected production deploy/release");
        }
        return new ClassifiedAction("COMMAND_EXECUTION", environment,
                summary(params, "reason", "command", "Command execution"));
    }

    private String commandContext(JsonNode params) {
        StringBuilder context = new StringBuilder();
        append(context, text(params, "command"));
        append(context, text(params, "reason"));
        append(context, text(params, "cwd"));
        if (params != null && params.hasNonNull("commandActions")) append(context, params.get("commandActions").toString());
        if (params != null && params.hasNonNull("networkApprovalContext")) append(context, params.get("networkApprovalContext").toString());
        return context.toString().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim();
    }

    private String environment(JsonNode params) {
        String explicit = firstNonBlank(text(params, "environment"), text(params, "env"), text(params, "stage"));
        if (explicit != null) return normalizeEnvironment(explicit);
        String context = commandContext(params);
        return PRODUCTION_MARKER.matcher(context).find() ? "production" : "*";
    }

    private String userInputSummary(JsonNode params) {
        JsonNode questions = params == null ? null : params.path("questions");
        if (questions != null && questions.isArray() && !questions.isEmpty()) {
            return firstNonBlank(text(questions.get(0), "question"), "Agent requested user input");
        }
        return "Agent requested user input";
    }

    private String summary(JsonNode params, String primary, String secondary, String fallback) {
        return firstNonBlank(text(params, primary), secondary == null ? null : text(params, secondary), fallback);
    }

    private String text(JsonNode node, String field) {
        if (node == null || field == null || !node.hasNonNull(field)) return null;
        String value = node.get(field).asText();
        return value == null || value.isBlank() ? null : value;
    }

    private void append(StringBuilder builder, String value) {
        if (value == null || value.isBlank()) return;
        if (!builder.isEmpty()) builder.append(' ');
        builder.append(value);
    }

    private String normalizeAction(String action) {
        if (action == null || action.isBlank()) return "*";
        return action.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
    }

    private String normalizeEnvironment(String environment) {
        if (environment == null || environment.isBlank()) return "*";
        return environment.trim().toLowerCase(Locale.ROOT);
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value;
        }
        return null;
    }

    public record ClassifiedAction(String action, String environment, String summary) {}
}
