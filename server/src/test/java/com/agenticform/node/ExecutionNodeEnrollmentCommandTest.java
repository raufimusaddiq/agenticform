package com.agenticform.node;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

class ExecutionNodeEnrollmentCommandTest {
    @Test
    void nodeContainersAllowBubblewrapNamespaces() {
        String options = ExecutionNodeService.dockerRuntimeSecurityOptions();

        assertTrue(options.contains("--security-opt seccomp=unconfined"));
        assertTrue(options.contains("--security-opt apparmor=unconfined"));
        assertTrue(options.contains("--security-opt no-new-privileges:true"));
        assertTrue(options.contains("--cap-drop ALL"));
    }
}
