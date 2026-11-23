import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { ProjectPage } from "@/pages/ProjectPage";

/** One project's overview: its stages, what needs care, who works on it and its repositories (ADR 0219 §8). */
export const Route = createFileRoute("/org/$orgId/projects/$projectId")({
  component: function Page() {
    const { projectId } = Route.useParams();
    return (
      <Main>
        <ProjectPage key={projectId} projectId={projectId} />
      </Main>
    );
  },
});
