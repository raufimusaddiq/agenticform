package com.agenticform.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

@ConfigurationProperties(prefix = "agenticform")
public class AgenticformProperties {
    private List<String> projectRoots = new ArrayList<>(List.of("/srv/apps"));
    private URI publicUrl = URI.create("http://localhost:8080");
    private final Codex codex = new Codex();
    private final Workspace workspace = new Workspace();
    private final Ui ui = new Ui();
    private final GitHub github = new GitHub();
    private final Node node = new Node();
    private final Security security = new Security();

    public List<String> getProjectRoots() { return projectRoots; }
    public void setProjectRoots(List<String> projectRoots) { this.projectRoots = projectRoots; }
    public URI getPublicUrl() { return publicUrl; }
    public void setPublicUrl(URI publicUrl) { this.publicUrl = publicUrl; }
    public Codex getCodex() { return codex; }
    public Workspace getWorkspace() { return workspace; }
    public Ui getUi() { return ui; }
    public GitHub getGithub() { return github; }
    public Node getNode() { return node; }
    public Security getSecurity() { return security; }

    public static class Codex {
        private URI endpoint = URI.create("ws://127.0.0.1:4500");
        private Duration requestTimeout = Duration.ofSeconds(30);
        private boolean experimentalApi = true;

        public URI getEndpoint() { return endpoint; }
        public void setEndpoint(URI endpoint) { this.endpoint = endpoint; }
        public Duration getRequestTimeout() { return requestTimeout; }
        public void setRequestTimeout(Duration requestTimeout) { this.requestTimeout = requestTimeout; }
        public boolean isExperimentalApi() { return experimentalApi; }
        public void setExperimentalApi(boolean experimentalApi) { this.experimentalApi = experimentalApi; }
    }

    public static class Workspace {
        private String root = "/srv/agenticform/worktrees";
        private Duration gitTimeout = Duration.ofSeconds(30);
        private Duration cleanupRetention = Duration.ofHours(24);

        public String getRoot() { return root; }
        public void setRoot(String root) { this.root = root; }
        public Duration getGitTimeout() { return gitTimeout; }
        public void setGitTimeout(Duration gitTimeout) { this.gitTimeout = gitTimeout; }
        public Duration getCleanupRetention() { return cleanupRetention; }
        public void setCleanupRetention(Duration cleanupRetention) { this.cleanupRetention = cleanupRetention; }
    }

    public static class Ui {
        private String origin = "http://localhost:5173";

        public String getOrigin() { return origin; }
        public void setOrigin(String origin) { this.origin = origin; }
    }

    public static class GitHub {
        private URI apiUrl = URI.create("https://api.github.com");
        private String token = "";
        private String webhookSecret = "";
        private Duration pollInterval = Duration.ofSeconds(3);

        public URI getApiUrl() { return apiUrl; }
        public void setApiUrl(URI apiUrl) { this.apiUrl = apiUrl; }
        public String getToken() { return token; }
        public void setToken(String token) { this.token = token == null ? "" : token; }
        public String getWebhookSecret() { return webhookSecret; }
        public void setWebhookSecret(String webhookSecret) { this.webhookSecret = webhookSecret == null ? "" : webhookSecret; }
        public Duration getPollInterval() { return pollInterval; }
        public void setPollInterval(Duration pollInterval) { this.pollInterval = pollInterval; }
    }

    public static class Node {
        private Duration enrollmentTtl = Duration.ofMinutes(10);
        private Duration offlineAfter = Duration.ofSeconds(45);
        private Duration commandLease = Duration.ofMinutes(15);
        private Duration requestNonceTtl = Duration.ofMinutes(10);
        private Duration maxClockSkew = Duration.ofMinutes(2);
        private String image = "ghcr.io/raufimusaddiq/agenticform-node:latest";

        public Duration getEnrollmentTtl() { return enrollmentTtl; }
        public void setEnrollmentTtl(Duration enrollmentTtl) { this.enrollmentTtl = enrollmentTtl; }
        public Duration getOfflineAfter() { return offlineAfter; }
        public void setOfflineAfter(Duration offlineAfter) { this.offlineAfter = offlineAfter; }
        public Duration getCommandLease() { return commandLease; }
        public void setCommandLease(Duration commandLease) { this.commandLease = commandLease; }
        public Duration getRequestNonceTtl() { return requestNonceTtl; }
        public void setRequestNonceTtl(Duration requestNonceTtl) { this.requestNonceTtl = requestNonceTtl; }
        public Duration getMaxClockSkew() { return maxClockSkew; }
        public void setMaxClockSkew(Duration maxClockSkew) { this.maxClockSkew = maxClockSkew; }
        public String getImage() { return image; }
        public void setImage(String image) { this.image = image; }
    }

    public static class Security {
        private String adminToken = "";

        public String getAdminToken() { return adminToken; }
        public void setAdminToken(String adminToken) { this.adminToken = adminToken == null ? "" : adminToken; }
    }
}
