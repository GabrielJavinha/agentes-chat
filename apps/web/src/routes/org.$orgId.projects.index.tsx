import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { ProjectsPage } from "@/pages/ProjectsPage";

/** Projects: a card per project, with its repositories and who works on it now; a card opens its board (ADR 0219 §7). */
export const Route = createFileRoute("/org/$orgId/projects/")({
  component: () => (
    <Main>
      <ProjectsPage />
    </Main>
  ),
});
