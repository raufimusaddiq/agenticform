package com.agenticform.node;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface NodeEnrollmentTokenRepository extends JpaRepository<NodeEnrollmentTokenEntity, UUID> {
    Optional<NodeEnrollmentTokenEntity> findByTokenHash(String tokenHash);
}
