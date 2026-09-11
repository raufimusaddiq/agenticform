package com.agenticform.approval;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/approvals")
public class HumanApprovalController {
    private final HumanApprovalService service;

    public HumanApprovalController(HumanApprovalService service) {
        this.service = service;
    }

    @GetMapping
    public List<HumanApprovalEntity> list(@RequestParam(required = false) UUID projectId,
                                          @RequestParam(required = false) HumanApprovalStatus status) {
        return service.list(projectId, status);
    }

    @PostMapping("/{approvalId}/decision")
    public HumanApprovalEntity decide(@PathVariable UUID approvalId,
                                      @Valid @RequestBody DecisionRequest request) {
        return service.decide(approvalId, request.decision());
    }

    @PostMapping("/{approvalId}/answer")
    public HumanApprovalEntity answer(@PathVariable UUID approvalId,
                                      @Valid @RequestBody AnswerRequest request) {
        return service.answer(approvalId, request.answers());
    }

    public record DecisionRequest(@NotNull HumanApprovalDecision decision) {}
    public record AnswerRequest(@NotNull Map<String, List<String>> answers) {}
}
