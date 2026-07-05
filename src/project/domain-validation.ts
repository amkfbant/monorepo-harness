import { ProjectError } from "./errors.js";
import { loadProjectById } from "./profile-resolver.js";
import type { ProjectDomain, ProjectProfile } from "./schema.js";

export function projectDomainIds(profile: ProjectProfile): string[] {
  return profile.domains.map((domain) => domain.id);
}

export function formatValidDomains(domainIds: readonly string[]): string {
  return domainIds.length > 0 ? domainIds.join(", ") : "(none)";
}

export function undefinedProjectDomainMessage(
  projectId: string,
  domain: string,
  domainIds: readonly string[],
): string {
  return (
    `domain "${domain}" is not defined in project "${projectId}"; ` +
    `valid domains: ${formatValidDomains(domainIds)}`
  );
}

export function requireProjectDomain(
  profile: ProjectProfile,
  projectId: string,
  domain: string,
): ProjectDomain {
  const domainSpec = profile.domains.find((candidate) => candidate.id === domain);
  if (domainSpec === undefined) {
    throw new ProjectError(
      undefinedProjectDomainMessage(projectId, domain, projectDomainIds(profile)),
    );
  }
  return domainSpec;
}

export async function assertProjectDomainDefined(
  harnessRoot: string,
  projectId: string,
  domain: string,
): Promise<void> {
  const { profile } = await loadProjectById(harnessRoot, projectId, {});
  requireProjectDomain(profile, projectId, domain);
}
