package com.agenticform.operation;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;

@Service
public class GitHubWebhookService {
    private final AgenticformProperties.GitHub properties;
    private final GitHubWebhookDeliveryRepository deliveries;
    private final ExternalWorkflowService workflows;
    private final ObjectMapper mapper;

    public GitHubWebhookService(AgenticformProperties properties,
                                GitHubWebhookDeliveryRepository deliveries,
                                ExternalWorkflowService workflows,
                                ObjectMapper mapper) {
        this.properties = properties.getGithub();
        this.deliveries = deliveries;
        this.workflows = workflows;
        this.mapper = mapper;
    }

    public boolean configured() {
        return properties.getWebhookSecret() != null && !properties.getWebhookSecret().isBlank();
    }

    public synchronized boolean receive(String deliveryId, String event, String signature, byte[] body) throws Exception {
        if (!configured()) throw new IllegalStateException("GitHub webhook secret is not configured");
        if (deliveryId == null || deliveryId.isBlank()) throw new IllegalArgumentException("Missing X-GitHub-Delivery");
        if (event == null || event.isBlank()) throw new IllegalArgumentException("Missing X-GitHub-Event");
        verify(signature, body);

        String payloadHash = sha256(body);
        var existing = deliveries.findById(deliveryId);
        if (existing.isPresent()) {
            if (!existing.get().getPayloadSha256().equals(payloadHash)) {
                throw new SecurityException("GitHub delivery id was replayed with a different payload");
            }
            return false;
        }

        if ("workflow_run".equals(event)) {
            JsonNode root = mapper.readTree(body);
            JsonNode run = root.path("workflow_run");
            String repository = root.path("repository").path("full_name").asText();
            if (repository.isBlank() || run.isMissingNode()) throw new IllegalArgumentException("Invalid workflow_run webhook payload");
            Instant createdAt = parseInstant(run.path("created_at").asText());
            workflows.handleWebhook(new ExternalWorkflowService.WorkflowWebhook(
                    run.path("id").asLong(),
                    repository,
                    nullableText(run, "path"),
                    nullableText(run, "head_branch"),
                    nullableText(run, "head_sha"),
                    nullableText(run, "status"),
                    nullableText(run, "conclusion"),
                    nullableText(run, "html_url"),
                    createdAt
            ));
        }

        deliveries.save(new GitHubWebhookDeliveryEntity(deliveryId, event, payloadHash));
        return true;
    }

    private void verify(String signature, byte[] body) throws Exception {
        if (signature == null || !signature.startsWith("sha256=")) {
            throw new SecurityException("Missing or invalid X-Hub-Signature-256");
        }
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(properties.getWebhookSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String expected = "sha256=" + HexFormat.of().formatHex(mac.doFinal(body));
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), signature.getBytes(StandardCharsets.US_ASCII))) {
            throw new SecurityException("Invalid GitHub webhook signature");
        }
    }

    private String sha256(byte[] body) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
    }

    private Instant parseInstant(String value) {
        try { return value == null || value.isBlank() ? null : Instant.parse(value); }
        catch (Exception ignored) { return null; }
    }

    private String nullableText(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
