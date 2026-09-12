package com.agenticform.runtime;

import com.agenticform.agent.AgentCapabilityProfile;
import com.agenticform.codex.CodexGateway;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class CodexAgentRuntime implements AgentRuntime {
    private final CodexGateway gateway;

    public CodexAgentRuntime(CodexGateway gateway) {
        this.gateway = gateway;
    }

    @Override
    public RuntimeType type() { return RuntimeType.CODEX; }

    @Override
    public Map<String, Object> startParameters(String cwd, String responsibility,
                                               AgentCapabilityProfile capabilityProfile) {
        return gateway.startParameters(cwd, responsibility, capabilityProfile);
    }

    @Override
    public RuntimeSession start(String cwd, String responsibility, AgentCapabilityProfile capabilityProfile) {
        CodexGateway.ThreadHandle thread = gateway.startThread(cwd, responsibility, capabilityProfile);
        return new RuntimeSession(thread.threadId());
    }

    @Override
    public RuntimeDispatchReceipt dispatch(RuntimeSession session, String clientMessageId, String prompt) {
        CodexGateway.DispatchReceipt receipt = gateway.dispatchTask(session.id(), clientMessageId, prompt);
        return new RuntimeDispatchReceipt(receipt.queuedSubmissionId(), receipt.turnId());
    }

    @Override
    public void resume(RuntimeSession session) { gateway.resumeThread(session.id()); }

    @Override
    public void interrupt(RuntimeSession session, String turnId) { gateway.interruptTurn(session.id(), turnId); }
}
