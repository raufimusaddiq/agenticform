package com.agenticform.task;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Structured, machine-checkable task evidence. Prose is retained for humans, but
 * completion gates read only these fields.
 */
public record TaskEvidence(
        String outcome,
        List<Artifact> artifacts,
        List<Validation> validations,
        List<String> blockers,
        List<String> followUp
) {
    public static final String COMPLETED = "COMPLETED";
    public static final String BLOCKED = "BLOCKED";
    public static final String FAILED = "FAILED";

    public enum ArtifactType {
        ANALYSIS,
        DOCUMENT,
        COMMIT,
        PULL_REQUEST,
        REVIEW,
        TEST_RUN,
        OPERATION_RUN,
        DEPLOYMENT
    }

    public record Artifact(ArtifactType type, String reference, String revision, String digest) {}

    public record Validation(String name, String status, String reference) {
        public static final String PASSED = "PASSED";
        public static final String FAILED = "FAILED";
        public static final String NOT_RUN = "NOT_RUN";
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public boolean hasArtifact(ArtifactType type) {
        return artifacts.stream().anyMatch(artifact -> artifact.type() == type);
    }

    public boolean hasRevisionedArtifact(ArtifactType type) {
        return artifacts.stream().anyMatch(artifact -> artifact.type() == type
                && present(artifact.reference()) && present(artifact.revision()));
    }

    public boolean hasPassedValidation() {
        return validations.stream().anyMatch(validation -> Validation.PASSED.equalsIgnoreCase(validation.status())
                && present(validation.name()));
    }

    public boolean hasUnresolvedBlocker() {
        return !blockers.isEmpty();
    }

    public String acceptedRevision() {
        for (ArtifactType type : List.of(ArtifactType.PULL_REQUEST, ArtifactType.COMMIT, ArtifactType.DOCUMENT,
                ArtifactType.ANALYSIS, ArtifactType.REVIEW, ArtifactType.TEST_RUN)) {
            for (Artifact artifact : artifacts) {
                if (artifact.type() == type && present(artifact.revision())) return artifact.revision();
            }
        }
        return null;
    }

    public String serialize() {
        ObjectNode root = MAPPER.createObjectNode();
        root.put("outcome", outcome);
        ArrayNode artifactNodes = root.putArray("artifacts");
        for (Artifact artifact : artifacts) {
            ObjectNode node = artifactNodes.addObject();
            node.put("type", artifact.type().name());
            node.put("reference", artifact.reference());
            if (artifact.revision() != null) node.put("revision", artifact.revision());
            if (artifact.digest() != null) node.put("digest", artifact.digest());
        }
        ArrayNode validationNodes = root.putArray("validations");
        for (Validation validation : validations) {
            ObjectNode node = validationNodes.addObject();
            node.put("name", validation.name());
            node.put("status", validation.status());
            if (validation.reference() != null) node.put("reference", validation.reference());
        }
        ArrayNode blockerNodes = root.putArray("blockers");
        blockers.forEach(blockerNodes::add);
        ArrayNode followUpNodes = root.putArray("followUp");
        followUp.forEach(followUpNodes::add);
        return root.toString();
    }

    public static TaskEvidence parse(String json) {
        if (json == null || json.isBlank()) return null;
        JsonNode root = MAPPER.readTree(json);
        List<Artifact> artifacts = new ArrayList<>();
        for (JsonNode node : root.path("artifacts")) {
            artifacts.add(new Artifact(ArtifactType.valueOf(node.path("type").asText()),
                    node.path("reference").asText(null), node.path("revision").asText(null),
                    node.path("digest").asText(null)));
        }
        List<Validation> validations = new ArrayList<>();
        for (JsonNode node : root.path("validations")) {
            validations.add(new Validation(node.path("name").asText(null), node.path("status").asText(null),
                    node.path("reference").asText(null)));
        }
        return new TaskEvidence(root.path("outcome").asText(GENERAL_OUTCOME_FALLBACK), artifacts, validations,
                textList(root.path("blockers")), textList(root.path("followUp")));
    }

    private static final String GENERAL_OUTCOME_FALLBACK = "UNKNOWN";

    private static List<String> textList(JsonNode node) {
        List<String> values = new ArrayList<>();
        for (JsonNode entry : node) {
            String value = entry.asText();
            if (present(value)) values.add(value.trim());
        }
        return List.copyOf(values);
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }

    public static String normalizeOutcome(String outcome) {
        return outcome == null ? null : outcome.trim().toUpperCase(Locale.ROOT);
    }

    public static String normalizeValidationStatus(String status) {
        return status == null ? null : status.trim().toUpperCase(Locale.ROOT);
    }
}
