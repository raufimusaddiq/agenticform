package com.agenticform.message;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentMessageDeliveryRepository extends JpaRepository<AgentMessageDeliveryEntity, UUID> {
    List<AgentMessageDeliveryEntity> findAllByMessageIdOrderByCreatedAtAsc(UUID messageId);
    List<AgentMessageDeliveryEntity> findAllByToAgentIdOrderByCreatedAtDesc(UUID toAgentId);
    List<AgentMessageDeliveryEntity> findTop50ByStatusOrderByCreatedAtAsc(AgentMessageStatus status);
    List<AgentMessageDeliveryEntity> findAllByStatus(AgentMessageStatus status);
    Optional<AgentMessageDeliveryEntity> findByMessageIdAndToAgentId(UUID messageId, UUID toAgentId);
    Optional<AgentMessageDeliveryEntity> findByTurnId(String turnId);
    Optional<AgentMessageDeliveryEntity> findFirstByToAgentIdAndStatusOrderByCreatedAtAsc(UUID toAgentId, AgentMessageStatus status);
}
