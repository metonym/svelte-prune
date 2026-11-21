import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hydrateRemoved, pruneRuntime } from "../src/runtime";
import { createFakeProject } from "./helpers/fake-project";
import { resolvePackageRoot } from "./helpers/resolve-package-root";

const CLIENT = path.join(resolvePackageRoot("svelte"), "src/internal/client");
const FLAG_FILE = path.join(CLIENT, "dom/hydration.js");
const RENDER_FILE = path.join(CLIENT, "render.js");
const UNCHANGED = /left Svelte's hydration code in this build/;
const SETS_FLAG = /\bhydrating\s*=\s*value/;
const HYDRATE_THROWS =
  /export function hydrate\(component, options\) \{ throw new Error\(/;

const prune = (file: string, code = readFileSync(file, "utf8")) =>
  pruneRuntime(file, code, "svelte-prune");

describe("pruneRuntime", () => {
  test("folds `hydrating` to `false` in the installed Svelte", () => {
    const pruned = prune(FLAG_FILE);
    if (!pruned || !("code" in pruned)) throw new Error("not pruned");
    expect(pruned.code).toContain("export const hydrating = false;");
    expect(pruned.code).not.toMatch(SETS_FLAG);
    // Within lines, so the bundler's source map holds.
    const lines = (code: string) => code.split("\n").length;
    expect(lines(pruned.code)).toBe(lines(readFileSync(FLAG_FILE, "utf8")));
  });

  test("makes `hydrate()` throw before it runs", () => {
    const pruned = prune(RENDER_FILE);
    if (!pruned || !("code" in pruned)) throw new Error("not pruned");
    expect(pruned.code).toMatch(HYDRATE_THROWS);
    expect(pruned.code).toContain(hydrateRemoved("svelte-prune"));
    // `mount` is untouched.
    expect(pruned.code).toContain(
      "export function mount(component, options) {",
    );
  });

  test("leaves every other module alone", () => {
    expect(prune(path.join(CLIENT, "runtime.js"))).toBeUndefined();
    expect(
      pruneRuntime("/app/src/dom/hydration.js", "", "svelte-prune"),
    ).toBeUndefined();
  });

  test.each([
    ["hydration.js", "export let hydrating = true;"],
    [
      "hydration.js",
      "export let hydrating = false;\nexport function set_hydrating(value) {\n\thydrating = value;\n}\nhydrating = 1;",
    ],
    ["render.js", "export function hydrate(component, options = {}) {}"],
  ])("rewrites neither module when %s isn't as expected", (changed, source) => {
    const project = createFakeProject();
    try {
      const client = path.join(
        project.root,
        "node_modules/svelte/src/internal/client",
      );
      mkdirSync(path.join(client, "dom"), { recursive: true });
      const flag = path.join(client, "dom/hydration.js");
      const render = path.join(client, "render.js");
      writeFileSync(flag, readFileSync(FLAG_FILE, "utf8"));
      writeFileSync(render, readFileSync(RENDER_FILE, "utf8"));
      writeFileSync(changed === "render.js" ? render : flag, source);
      for (const file of [flag, render]) {
        const pruned = prune(file);
        expect(pruned && "warning" in pruned && pruned.warning).toMatch(
          UNCHANGED,
        );
      }
    } finally {
      project.dispose();
    }
  });
});
