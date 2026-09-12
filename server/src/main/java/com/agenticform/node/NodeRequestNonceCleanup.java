package com.agenticform.node;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Component
public class NodeRequestNonceCleanup {
    private final NodeRequestNonceRepository repository;

    public NodeRequestNonceCleanup(NodeRequestNonceRepository repository) {
        this.repository = repository;
    }

    @Scheduled(fixedDelayString = "${agenticform.node.nonce-cleanup-delay-ms:600000}")
    @Transactional
    public void cleanup() {
        repository.deleteByExpiresAtBefore(Instant.now());
    }
}
