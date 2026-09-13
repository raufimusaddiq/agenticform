package com.agenticform.task;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

class TaskContextCompactorTest {
    @Test
    void compactsLargeContextWhileKeepingBothEdges() {
        String value = "HEAD-" + "x".repeat(9000) + "-TAIL";
        String compacted = TaskContextCompactor.compact(value, 6000);

        assertTrue(compacted.length() < value.length());
        assertTrue(compacted.startsWith("HEAD-"));
        assertTrue(compacted.endsWith("-TAIL"));
        assertTrue(compacted.contains("[context compacted]"));
    }
}
