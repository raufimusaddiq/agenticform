package com.agenticform.message;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentMessageRepository extends JpaRepository<AgentMessageEntity, UUID> {
    List<AgentMessageEntity> findAllByProjectIdOrderByCreatedAtDesc(UUID projectId);
    List<AgentMessageEntity> findAllByToAgentIdOrderByCreatedAtDesc(UUID toAgentId);
    List<AgentMessageEntity> findAllByConversationIdOrderByCreatedAtAsc(UUID conversationId);
    List<AgentMessageEntity> findTop50ByStatusInOrderByCreatedAtAsc(List<AgentMessageStatus> statuses);
}
