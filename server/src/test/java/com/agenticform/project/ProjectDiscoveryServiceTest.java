package com.agenticform.project;

import com.agenticform.config.AgenticformProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ProjectDiscoveryServiceTest {
    @TempDir Path temp;

    @Test
    void discoversGitRepositoriesAndCurrentBranchInsideApprovedRoot() throws Exception {
        Path allowed = Files.createDirectories(temp.resolve("apps"));
        Path repo = Files.createDirectories(allowed.resolve("alpha"));
        Path git = Files.createDirectories(repo.resolve(".git"));
        Files.writeString(git.resolve("HEAD"), "ref: refs/heads/feature/discovery\n");

        ProjectRepository repository = mock(ProjectRepository.class);
        when(repository.findByRootDirectory(anyString())).thenReturn(Optional.empty());
        ProjectDiscoveryService service = service(allowed, repository, 3, 20);

        assertThat(service.discover())
                .singleElement()
                .satisfies(candidate -> {
                    assertThat(candidate.name()).isEqualTo("alpha");
                    assertThat(candidate.path()).isEqualTo(repo.toRealPath().toString());
                    assertThat(candidate.configuredRoot()).isEqualTo(allowed.toRealPath().toString());
                    assertThat(candidate.detectedBranch()).isEqualTo("feature/discovery");
                    assertThat(candidate.registered()).isFalse();
                });
    }

    @Test
    void doesNotFollowSymlinkOutsideApprovedRootAndHonorsDepthBound() throws Exception {
        Path allowed = Files.createDirectories(temp.resolve("apps"));
        Path directRepo = gitRepo(allowed.resolve("direct"));
        Path tooDeep = gitRepo(allowed.resolve("a/b/c/repo"));
        Path outside = gitRepo(temp.resolve("outside/secret"));
        Files.createSymbolicLink(allowed.resolve("linked-secret"), outside);

        ProjectRepository repository = mock(ProjectRepository.class);
        when(repository.findByRootDirectory(anyString())).thenReturn(Optional.empty());
        ProjectDiscoveryService service = service(allowed, repository, 2, 20);

        assertThat(service.discover())
                .extracting(ProjectDiscoveryService.Candidate::path)
                .containsExactly(directRepo.toRealPath().toString())
                .doesNotContain(tooDeep.toRealPath().toString(), outside.toRealPath().toString());
    }

    @Test
    void capsCandidateCountDeterministically() throws Exception {
        Path allowed = Files.createDirectories(temp.resolve("apps"));
        gitRepo(allowed.resolve("a"));
        gitRepo(allowed.resolve("b"));
        gitRepo(allowed.resolve("c"));

        ProjectRepository repository = mock(ProjectRepository.class);
        when(repository.findByRootDirectory(anyString())).thenReturn(Optional.empty());
        ProjectDiscoveryService service = service(allowed, repository, 3, 2);

        assertThat(service.discover()).hasSize(2);
    }

    private ProjectDiscoveryService service(Path allowed, ProjectRepository repository,
                                            int maxDepth, int maxCandidates) {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setProjectRoots(java.util.List.of(allowed.toString()));
        properties.getProjectDiscovery().setMaxDepth(maxDepth);
        properties.getProjectDiscovery().setMaxCandidates(maxCandidates);
        ProjectPathPolicy policy = new ProjectPathPolicy(properties);
        return new ProjectDiscoveryService(policy, repository, properties);
    }

    private Path gitRepo(Path path) throws Exception {
        Path repo = Files.createDirectories(path);
        Path git = Files.createDirectories(repo.resolve(".git"));
        Files.writeString(git.resolve("HEAD"), "ref: refs/heads/main\n");
        return repo;
    }
}
