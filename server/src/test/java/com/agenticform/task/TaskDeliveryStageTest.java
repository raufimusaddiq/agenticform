package com.agenticform.task;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class TaskDeliveryStageTest {
    @Test
    void milestonesOnlyMoveForward() {
        assertEquals(TaskDeliveryStage.DEPLOYING,
                TaskDeliveryStage.REVIEW_PASSED.advanceTo(TaskDeliveryStage.DEPLOYING));
        assertEquals(TaskDeliveryStage.DELIVERED,
                TaskDeliveryStage.DEPLOYING.advanceTo(TaskDeliveryStage.DELIVERED));
    }

    @Test
    void laterSignalsNeverRegressTheStage() {
        assertEquals(TaskDeliveryStage.DELIVERED,
                TaskDeliveryStage.DELIVERED.advanceTo(TaskDeliveryStage.REVIEW_PASSED));
        assertEquals(TaskDeliveryStage.IMPLEMENTED,
                TaskDeliveryStage.IMPLEMENTED.advanceTo(TaskDeliveryStage.NOT_STARTED));
        assertEquals(TaskDeliveryStage.DEPLOYMENT_VERIFIED,
                TaskDeliveryStage.DEPLOYMENT_VERIFIED.advanceTo(TaskDeliveryStage.DEPLOYING));
    }

    @Test
    void sameStageAndNullAreNoops() {
        assertEquals(TaskDeliveryStage.MERGED, TaskDeliveryStage.MERGED.advanceTo(TaskDeliveryStage.MERGED));
        assertEquals(TaskDeliveryStage.MERGED, TaskDeliveryStage.MERGED.advanceTo(null));
    }
}
