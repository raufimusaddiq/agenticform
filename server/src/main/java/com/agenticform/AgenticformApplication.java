package com.agenticform;

import com.agenticform.config.AgenticformProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(AgenticformProperties.class)
public class AgenticformApplication {
    public static void main(String[] args) {
        SpringApplication.run(AgenticformApplication.class, args);
    }
}
