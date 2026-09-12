package com.agenticform.runtime;

import com.agenticform.agent.AgentCapabilityProfile;

public interface AgentRuntime {
    RuntimeType type();

    RuntimeSession start(String cwd, String responsibility, AgentCapabilityProfile capabilityProfile);

    RuntimeDispatchReceipt dispatch(RuntimeSession session, String clientMessageId, String prompt);

    void resume(RuntimeSession session);

    void interrupt(RuntimeSession session, String turnId);
}
