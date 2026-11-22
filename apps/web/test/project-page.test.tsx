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
const go = async (api: ReturnType<typeof createFakeApi>, projectId: string) => {
  const r = await renderApp(`/org/${ORG_ID}/projects/${projectId}`, { api });
  await settle(8);
  return r;
};
const group = (name: string) => screen().getByRole("region", { name });
const rows = (name: string) =>
  [...group(name).querySelectorAll<HTMLElement>(".ac-list__row")].map((r) => r.textContent ?? "");

/** The longest name a project takes: 80 characters, no space to wrap at for its first 42. */
const LONG = `${"Reestruturação".repeat(3)} do atendimento da Clínica Teo em 2026 e 2027`.slice(0, 80);

/**
 * Clínica Teo with five tasks: the agent at work on one, a person's late one, one blocked, one stalled and one done;
 * and an empty project with the longest name.
 */
async function withProject() {
  const state = seedState();
  const api = createFakeApi(state);
  const clinic = await api.issues.createProject(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const empty = await api.issues.createProject(ORG_ID, { name: LONG, color: "violet" });
  const tasks = await api.issues.list(ORG_ID, {});
  const put = async (title: string, more: Parameters<typeof api.issues.update>[2] = {}) => {
    const task = tasks.find((i) => i.title.startsWith(title));
    if (!task) throw new Error(`no task ${title}`);
    return api.issues.update(ORG_ID, task.id, { projectId: clinic.id, ...more });
  };
  const working = await put("Timeout no agendamento");
  const late = await put("Revisar textos do onboarding", { dueDate: "2020-01-02" });
  const blocked = await put("Confirmação do agendamento", { status: "in_progress" });
  // Background work stopped on a question (ADR 0121): the server says so on the task, the fake has no way to.
  const list = api.issues.list.bind(api.issues);
  api.issues.list = async (...args) =>
    (await list(...args)).map((i) =>
      i.id === blocked.id ? { ...i, blocked: { reason: "waiting_input", since: "2026-11-20T10:00:00.000Z" } } : i,
    );
  const done = await put("Organizar o roadmap");
  await api.issues.setProjectRepositories(ORG_ID, clinic.id, ["acme/app"]);
  return { state, api, clinic, empty, working, late, blocked, done };
}

describe("A project's overview", () => {
  test("its stages, what needs care, who works on it and what changed last", async () => {
    const { api, clinic, working, late, blocked, state } = await withProject();
    await go(api, clinic.id);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Clínica Teo");
    expect(document.querySelector(".ac-pagehead, .page")?.textContent).toContain("1 de 4 tarefas concluídas");
    const stages = [...group("Etapas").querySelectorAll(".ac-facts__item")].map((f) => f.textContent);
    expect(stages).toEqual(["A fazer0", "Em andamento3", "Em revisão0", "Feito1"]);
    // Late first, then blocked, each with why.
    const care = rows("Precisa de atenção");
    expect(care).toHaveLength(2);
    expect(care[0]).toContain(`#${late.number}`);
    expect(care[0]).toContain("Atrasada desde");
    expect(care[1]).toContain(`#${blocked.number}`);
    // The agent at work leads, saying so.
    const who = rows("Quem trabalha nele");
    const agentAt = state.agents.find((a) => a.id === working.assignees[0]?.id);
    expect(who[0]).toContain(agentAt?.name ?? "?");
    expect(who[0]).toContain("Trabalhando agora");
    expect(rows("Atualizadas por último")).toHaveLength(4);
    expect(document.querySelector(".agp-repos")?.textContent).toContain("acme/app");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("Abrir quadro opens the project's board, and a task's row opens the task", async () => {
    const { api, clinic, late } = await withProject();
    const { router } = await go(api, clinic.id);
    await click(screen().getByRole("link", { name: "Abrir quadro" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
    expect((router.state.location.search as { project?: string }).project).toBe(clinic.id);
    cleanup();
    const again = await go(api, clinic.id);
    const row = [...group("Precisa de atenção").querySelectorAll<HTMLElement>("a.ac-list__row")][0] as HTMLElement;
    await click(row);
    await settle(6);
    expect(again.router.state.location.pathname).toBe(`/org/${ORG_ID}/issues/${late.number}`);
  });

  test("a project with no task says so once, the longest name whole", async () => {
    const { api, empty } = await withProject();
    await go(api, empty.id);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe(LONG);
    expect(screen().getByText("Nenhuma tarefa neste projeto ainda.")).toBeTruthy();
    // Said once: no empty stages, no "nobody" under who works on it.
    expect(screen().queryByRole("region", { name: "Etapas" })).toBeNull();
    expect(screen().queryByText("Ninguém nas tarefas abertas")).toBeNull();
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("deleted from its menu, it sends the reader back to the projects", async () => {
    const { api, clinic } = await withProject();
    const { router } = await go(api, clinic.id);
    await act(async () => fireEvent.keyDown(screen().getByRole("button", { name: "Mais opções" }), { key: "Enter" }));
    await settle(3);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Excluir projeto" }));
    const dialog = screen().getByRole("dialog", { name: "Excluir o projeto Clínica Teo?" });
    await click(within(dialog).getByRole("button", { name: "Excluir projeto" }));
    await settle(10);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/projects`);
  });

  test("a link to a project that is gone goes back to the projects", async () => {
    const { api } = await withProject();
    const { router } = await go(api, "00000000-0000-7000-8000-000000000999");
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/projects`);
  });

  test("whoever can't post sees the overview but no menu", async () => {
    const { api, clinic, state } = await withProject();
    Object.assign(state.me?.organizations[0] ?? {}, { role: "member", permissions: ["read"] });
    await go(api, clinic.id);
    expect(screen().getByRole("link", { name: "Abrir quadro" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Mais opções" })).toBeNull();
  });
});
