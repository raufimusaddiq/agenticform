package com.agenticform.node;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;
import java.util.UUID;

public interface NodeEnrollmentTokenRepository extends JpaRepository<NodeEnrollmentTokenEntity, UUID> {
    Optional<NodeEnrollmentTokenEntity> findByTokenHash(String tokenHash);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select token from NodeEnrollmentTokenEntity token where token.tokenHash = :tokenHash")
    Optional<NodeEnrollmentTokenEntity> findByTokenHashForUpdate(@Param("tokenHash") String tokenHash);
}
