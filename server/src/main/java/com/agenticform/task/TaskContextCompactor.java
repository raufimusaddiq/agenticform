package com.agenticform.task;

final class TaskContextCompactor {
    private static final int MAX_INHERITED_CONTEXT = 5000;
    private static final int MAX_DELEGATED_INSTRUCTIONS = 6000;

    private TaskContextCompactor() {}

    static String inherit(TaskEntity parent, String childPrompt) {
        String context = compact(parent.getPrompt(), MAX_INHERITED_CONTEXT);
        return "Parent task context (" + parent.getId() + "):\n" + context
                + "\n\nDelegated instructions:\n" + compact(childPrompt, MAX_DELEGATED_INSTRUCTIONS);
    }

    static String compact(String value, int limit) {
        if (value == null || value.length() <= limit) return value == null ? "" : value;
        int head = limit * 2 / 3;
        int tail = limit - head;
        return value.substring(0, head) + "\n...[context compacted]...\n" + value.substring(value.length() - tail);
    }
}
