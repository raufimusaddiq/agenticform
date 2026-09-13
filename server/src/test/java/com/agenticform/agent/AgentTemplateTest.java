package com.agenticform.agent;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AgentTemplateTest {
    @Test
    void architectTemplateIsReadOnly() {
        AgentTemplate template = AgentTemplate.find("architect");

        assertThat(template.getCapabilityProfile()).isEqualTo(AgentCapabilityProfile.ARCHITECT);
        assertThat(template.getResponsibility()).contains("Do not edit application code");
    }

    @Test
    void implementationTemplatesUseGenericCapabilityWithSpecialty() {
        assertThat(AgentTemplate.find("frontend").getCapabilityProfile()).isEqualTo(AgentCapabilityProfile.IMPLEMENTER);
        assertThat(AgentTemplate.find("frontend").getSpecialty()).isEqualTo("FRONTEND");
        assertThat(AgentTemplate.find("data").getSpecialty()).isEqualTo("DATA");
    }
}
