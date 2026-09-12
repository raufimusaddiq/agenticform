package com.agenticform.message;

import com.agenticform.project.ProjectRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class CommunicationRuleService {
    private final CommunicationRuleRepository rules;
    private final ProjectRepository projects;

    public CommunicationRuleService(CommunicationRuleRepository rules, ProjectRepository projects) {
        this.rules = rules;
        this.projects = projects;
    }

    public List<CommunicationRuleEntity> list() {
        return rules.findAllByOrderByCreatedAtAsc();
    }

    public boolean allows(UUID fromProjectId, UUID toProjectId, CommunicationRuleEntity.Action action) {
        if (fromProjectId.equals(toProjectId)) return true;
        return rules.findByFromProjectIdAndToProjectIdAndAction(fromProjectId, toProjectId, action)
                .filter(CommunicationRuleEntity::isEnabled)
                .map(rule -> rule.getEffect() == CommunicationRuleEntity.Effect.ALLOW)
                .orElse(false);
    }

    public void require(UUID fromProjectId, UUID toProjectId, CommunicationRuleEntity.Action action) {
        if (!allows(fromProjectId, toProjectId, action)) {
            throw new IllegalStateException("Cross-project " + action + " is not allowed from "
                    + fromProjectId + " to " + toProjectId);
        }
    }

    @Transactional
    public CommunicationRuleEntity upsert(UUID fromProjectId, UUID toProjectId,
                                          CommunicationRuleEntity.Action action,
                                          CommunicationRuleEntity.Effect effect,
                                          boolean enabled) {
        if (fromProjectId == null || toProjectId == null || fromProjectId.equals(toProjectId)) {
            throw new IllegalArgumentException("Communication rule requires two different projects");
        }
        if (!projects.existsById(fromProjectId) || !projects.existsById(toProjectId)) {
            throw new NoSuchElementException("Communication rule project does not exist");
        }
        CommunicationRuleEntity.Action effectiveAction = action == null
                ? CommunicationRuleEntity.Action.MESSAGE : action;
        CommunicationRuleEntity rule = rules.findByFromProjectIdAndToProjectIdAndAction(
                        fromProjectId, toProjectId, effectiveAction)
                .orElseGet(() -> new CommunicationRuleEntity(fromProjectId, toProjectId, effectiveAction, effect));
        rule.update(effect, enabled);
        return rules.save(rule);
    }

    @Transactional
    public void delete(UUID id) {
        if (!rules.existsById(id)) throw new NoSuchElementException("Communication rule not found: " + id);
        rules.deleteById(id);
    }
}
