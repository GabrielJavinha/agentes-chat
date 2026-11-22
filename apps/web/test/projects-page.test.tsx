import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const go = async (api = createFakeApi(seedState())) => {
  const r = await renderApp(`/org/${ORG_ID}/projects`, { api });
  await settle(8);
  return { ...r, api };
};
const cards = () => [...document.querySelectorAll<HTMLElement>(".projects-card")];
const cardNamed = (name: string) =>
  cards().find((c) => c.querySelector(".projects-card__name")?.textContent === name) as HTMLElement;
const names = () => cards().map((c) => c.querySelector(".projects-card__name")?.textContent);

/** The longest name a project takes: 80 characters, no space to wrap at for its first 42. */
const LONG = `${"Reestruturação".repeat(3)} do atendimento da Clínica Teo em 2026 e 2027`.slice(0, 80);

/**
 * Clínica Teo with three tasks (one an agent works on, one a person's, one done), three repositories and its issues
 * imported; Padaria Lia with nothing; the longest name with one task; and an archived one.
 */
async function withProjects() {
  const state = seedState();
  const api = createFakeApi(state);
  const make = (name: string, color: string) => api.issues.createProject(ORG_ID, { name, color });
  const clinic = await make("Clínica Teo", "teal");
  const bakery = await make("Padaria Lia", "amber");
  const long = await make(LONG, "violet");
  const old = await make("Acme 2025", "graphite");
  const tasks = await api.issues.list(ORG_ID, {});
  const put = async (title: string, projectId: string) => {
    const task = tasks.find((i) => i.title.startsWith(title));
    if (!task) throw new Error(`no task ${title}`);
    await api.issues.update(ORG_ID, task.id, { projectId });
    return task;
  };
  const working = await put("Timeout no agendamento", clinic.id);
  await put("Revisar textos do onboarding", clinic.id);
  await put("Organizar o roadmap", clinic.id);
  await put("Tabela de concorrentes", long.id);
  await put("Confirmação do agendamento", old.id);
  await api.issues.setProjectRepositories(ORG_ID, clinic.id, ["acme/app", "acme/site", "acme/api"]);
  await api.issues.setProjectGithubImport(ORG_ID, clinic.id, true);
  await api.issues.updateProject(ORG_ID, old.id, { archived: true });
  return { state, api, clinic, bakery, long, old, working };
}

describe("Projetos", () => {
  test("no project yet: the empty state says what one is and makes the first, which shows as a card", async () => {
    const { api } = await go();
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Projetos");
    expect(screen().getByText("Nenhum projeto ainda")).toBeTruthy();
    // One way in: the empty state's button, none in the header.
    const buttons = screen().getAllByRole("button", { name: "Novo projeto" });
    expect(buttons).toHaveLength(1);
    await click(buttons[0] as HTMLElement);
    const dialog = screen().getByRole("dialog");
    await act(async () => fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Site novo" } }));
    await click(within(dialog).getByRole("button", { name: "Criar projeto" }));
    await settle(6);
    expect((await api.issues.projects(ORG_ID)).projects.map((p) => p.name)).toEqual(["Site novo"]);
    expect(names()).toEqual(["Site novo"]);
    expect(cardNamed("Site novo").textContent).toContain("Nenhuma tarefa aberta");
    expect(screen().getAllByRole("button", { name: "Novo projeto" })).toHaveLength(1);
  });

  test("a card per project: its open tasks, its main repository and how many more, who works on it, the import", async () => {
    const { api, state, working } = await withProjects();
    await go(api);
    // By name, the archived one folded away.
    expect(names()).toEqual(["Clínica Teo", "Padaria Lia", LONG]);
    const clinic = cardNamed("Clínica Teo");
    expect(clinic.querySelector(".projects-card__meta")?.textContent).toBe("2 tarefas abertas");
    expect(clinic.querySelector(".projects-card__repo")?.textContent).toBe("acme/app +2 repositórios");
    expect(clinic.textContent).toContain("Issues do GitHub viram tarefas");
    // The done task's agent isn't on it; the agent at work comes first.
    const agentAt = state.agents.find((a) => a.id === working.assignees[0]?.id);
    const faces = clinic.querySelector(".issue-faces") as HTMLElement;
    expect(faces.getAttribute("aria-label")?.startsWith(agentAt?.name ?? "?")).toBe(true);
    expect(faces.querySelectorAll(".ac-avatar")).toHaveLength(2);

    const bakery = cardNamed("Padaria Lia");
    expect(bakery.querySelector(".projects-card__meta")?.textContent).toBe("Nenhuma tarefa aberta");
    expect(bakery.querySelector(".projects-card__repo")?.textContent).toBe("Sem repositório");
    expect(bakery.querySelector(".projects-card__foot")).toBeNull();
    expect(cardNamed(LONG).querySelector(".projects-card__meta")?.textContent).toBe("1 tarefa aberta");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("a card opens the project's overview", async () => {
    const { api, clinic } = await withProjects();
    const { router } = await go(api);
    await click(cardNamed("Clínica Teo"));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/projects/${clinic.id}`);
  });

  test("the archived ones wait under their heading, folded, and open on a click", async () => {
    const { api } = await withProjects();
    await go(api);
    const show = screen().getByRole("button", { name: "Mostrar arquivados" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(screen().getByRole("region", { name: "Arquivados" }).textContent).toContain("1");
    await click(show);
    expect(names()).toEqual(["Clínica Teo", "Padaria Lia", LONG, "Acme 2025"]);
    expect(cardNamed("Acme 2025").dataset.archived).toBe("true");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
    await click(screen().getByRole("button", { name: "Ocultar arquivados" }));
    expect(names()).not.toContain("Acme 2025");
  });

  test("whoever can't post sees the projects but makes none", async () => {
    const { api, state } = await withProjects();
    // The org's own keys, as `GET /me` sends them: reading, no posting.
    Object.assign(state.me?.organizations[0] ?? {}, { role: "member", permissions: ["read"] });
    await go(api);
    expect(names()).toEqual(["Clínica Teo", "Padaria Lia", LONG]);
    expect(screen().queryByRole("button", { name: "Novo projeto" })).toBeNull();
  });

  test("Projetos sits in the sidebar, after Tarefas, and opens this page", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(8);
    const nav = screen().getByRole("navigation", { name: /./ });
    const link = within(nav).getByRole("link", { name: "Projetos" });
    await click(link);
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/projects`);
  });
});
