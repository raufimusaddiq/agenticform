package com.agenticform.operation;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "github_webhook_deliveries")
public class GitHubWebhookDeliveryEntity {
    @Id
    @Column(name = "delivery_id", length = 128)
    private String deliveryId;

    @Column(nullable = false, length = 64)
    private String event;

    @Column(name = "payload_sha256", nullable = false, length = 64)
    private String payloadSha256;

    @Column(name = "received_at", nullable = false)
    private Instant receivedAt;

    protected GitHubWebhookDeliveryEntity() {}

    public GitHubWebhookDeliveryEntity(String deliveryId, String event, String payloadSha256) {
        this.deliveryId = deliveryId;
        this.event = event;
        this.payloadSha256 = payloadSha256;
    }

    @PrePersist
    void onCreate() { receivedAt = Instant.now(); }

    public String getDeliveryId() { return deliveryId; }
    public String getEvent() { return event; }
    public String getPayloadSha256() { return payloadSha256; }
    public Instant getReceivedAt() { return receivedAt; }
}
