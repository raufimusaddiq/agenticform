package com.agenticform.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

@ConfigurationProperties(prefix = "agenticform")
public class AgenticformProperties {
    private List<String> projectRoots = new ArrayList<>(List.of("/srv/apps"));
    private final Codex codex = new Codex();
    private final Workspace workspace = new Workspace();
    private final Ui ui = new Ui();
    private final GitHub github = new GitHub();

    public List<String> getProjectRoots() { return projectRoots; }
    public void setProjectRoots(List<String> projectRoots) { this.projectRoots = projectRoots; }
    public Codex getCodex() { return codex; }
    public Workspace getWorkspace() { return workspace; }
    public Ui getUi() { return ui; }
    public GitHub getGithub() { return github; }

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

        public String getRoot() { return root; }
        public void setRoot(String root) { this.root = root; }
        public Duration getGitTimeout() { return gitTimeout; }
        public void setGitTimeout(Duration gitTimeout) { this.gitTimeout = gitTimeout; }
    }

    public static class Ui {
        private String origin = "http://localhost:5173";

        public String getOrigin() { return origin; }
        public void setOrigin(String origin) { this.origin = origin; }
    }

    public static class GitHub {
        private URI apiUrl = URI.create("https://api.github.com");
        private String token = "";
        private Duration pollInterval = Duration.ofSeconds(3);

        public URI getApiUrl() { return apiUrl; }
        public void setApiUrl(URI apiUrl) { this.apiUrl = apiUrl; }
        public String getToken() { return token; }
        public void setToken(String token) { this.token = token == null ? "" : token; }
        public Duration getPollInterval() { return pollInterval; }
        public void setPollInterval(Duration pollInterval) { this.pollInterval = pollInterval; }
    }
}
