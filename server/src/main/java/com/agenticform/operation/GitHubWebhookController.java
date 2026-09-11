package com.agenticform.operation;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/webhooks/github")
public class GitHubWebhookController {
    private final GitHubWebhookService service;

    public GitHubWebhookController(GitHubWebhookService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<Void> receive(
            @RequestHeader(value = "X-GitHub-Delivery", required = false) String deliveryId,
            @RequestHeader(value = "X-GitHub-Event", required = false) String event,
            @RequestHeader(value = "X-Hub-Signature-256", required = false) String signature,
            @RequestBody byte[] body) throws Exception {
        if (!service.configured()) return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        try {
            service.receive(deliveryId, event, signature, body);
            return ResponseEntity.accepted().build();
        } catch (SecurityException error) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().build();
        }
    }
}
