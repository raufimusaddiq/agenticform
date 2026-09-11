package com.agenticform.operation;

import com.agenticform.config.AgenticformProperties;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class GitHubWebhookServiceTest {
    private static final String SECRET = "webhook-test-secret";
    private static final String PAYLOAD = """
            {
              "action": "completed",
              "repository": {"full_name": "owner/repo"},
              "workflow_run": {
                "id": 42,
                "path": ".github/workflows/ci.yml",
                "head_branch": "main",
                "head_sha": "abc123",
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.com/owner/repo/actions/runs/42",
                "created_at": "2026-09-11T10:00:00Z"
              }
            }
            """;

    @Test
    void verifiesSignatureAndForwardsWorkflowRun() throws Exception {
        AgenticformProperties properties = properties();
        GitHubWebhookDeliveryRepository deliveries = mock(GitHubWebhookDeliveryRepository.class);
        ExternalWorkflowService workflows = mock(ExternalWorkflowService.class);
        when(deliveries.findById("delivery-1")).thenReturn(Optional.empty());
        GitHubWebhookService service = new GitHubWebhookService(properties, deliveries, workflows, new ObjectMapper());
        byte[] body = PAYLOAD.getBytes(StandardCharsets.UTF_8);

        boolean accepted = service.receive("delivery-1", "workflow_run", signature(body), body);

        assertThat(accepted).isTrue();
        ArgumentCaptor<ExternalWorkflowService.WorkflowWebhook> event = ArgumentCaptor.forClass(ExternalWorkflowService.WorkflowWebhook.class);
        verify(workflows).handleWebhook(event.capture());
        assertThat(event.getValue().runId()).isEqualTo(42);
        assertThat(event.getValue().repository()).isEqualTo("owner/repo");
        assertThat(event.getValue().workflowPath()).isEqualTo(".github/workflows/ci.yml");
        assertThat(event.getValue().headSha()).isEqualTo("abc123");
        verify(deliveries).save(any(GitHubWebhookDeliveryEntity.class));
    }

    @Test
    void rejectsInvalidSignature() {
        GitHubWebhookService service = new GitHubWebhookService(
                properties(), mock(GitHubWebhookDeliveryRepository.class),
                mock(ExternalWorkflowService.class), new ObjectMapper());
        byte[] body = PAYLOAD.getBytes(StandardCharsets.UTF_8);

        assertThatThrownBy(() -> service.receive("delivery-1", "workflow_run", "sha256=deadbeef", body))
                .isInstanceOf(SecurityException.class);
    }

    @Test
    void duplicateDeliveryIsIdempotent() throws Exception {
        AgenticformProperties properties = properties();
        GitHubWebhookDeliveryRepository deliveries = mock(GitHubWebhookDeliveryRepository.class);
        ExternalWorkflowService workflows = mock(ExternalWorkflowService.class);
        when(deliveries.findById("delivery-1")).thenReturn(Optional.empty());
        GitHubWebhookService service = new GitHubWebhookService(properties, deliveries, workflows, new ObjectMapper());
        byte[] body = PAYLOAD.getBytes(StandardCharsets.UTF_8);

        service.receive("delivery-1", "workflow_run", signature(body), body);
        ArgumentCaptor<GitHubWebhookDeliveryEntity> saved = ArgumentCaptor.forClass(GitHubWebhookDeliveryEntity.class);
        verify(deliveries).save(saved.capture());
        when(deliveries.findById("delivery-1")).thenReturn(Optional.of(saved.getValue()));

        boolean accepted = service.receive("delivery-1", "workflow_run", signature(body), body);

        assertThat(accepted).isFalse();
        verify(workflows, times(1)).handleWebhook(any());
    }

    private AgenticformProperties properties() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.getGithub().setWebhookSecret(SECRET);
        return properties;
    }

    private String signature(byte[] body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return "sha256=" + HexFormat.of().formatHex(mac.doFinal(body));
    }
}
