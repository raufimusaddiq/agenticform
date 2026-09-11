package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

public interface GitHubWebhookDeliveryRepository extends JpaRepository<GitHubWebhookDeliveryEntity, String> {
}
