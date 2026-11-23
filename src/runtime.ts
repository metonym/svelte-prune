import { readFileSync } from "node:fs";
import path from "node:path";

import { stripQuery } from "./util";

/**
 * `hydration: false`: Svelte 5's client runtime guards its hydration code
 * with `hydrating`, a `let` a bundler can't fold. For an app that only
 * mounts, it becomes `const hydrating = false`, and `hydrate()` throws
 * before it runs, so both go when the bundle is minified. Both files are
 * rewritten or neither, and an output that still holds `hydrate()` (the
 * app can reach it) fails the build.
 */

/** The two modules of Svelte's client runtime `pruneRuntime` rewrites. */
const RE_RUNTIME_FILE =
  /[\\/]svelte[\\/]src[\\/]internal[\\/]client[\\/](dom[\\/]hydration|render)\.js$/;

const FLAG = "export let hydrating = false;";
const SET_FLAG =
  /(export function set_hydrating\(\w+\)\s*\{\s*)hydrating = \w+;/;
const ASSIGNMENT = /\bhydrating\s*=(?!=)/g;
const HYDRATE = /export function hydrate\(\w+, \w+\)\s*\{/;

/** What `hydrate()` throws, and how a build tells it's still in the output. */
export const hydrateRemoved = (plugin: string) =>
  `${plugin} removed hydrate() from this build (hydration: false). Mount the app with mount(), or build it without hydration: false.`;

/**
 * `hydration.js` without the writes to `hydrating`, if Svelte's source is
 * as expected.
 */
function foldFlag(code: string): string | undefined {
  if (!code.includes(FLAG) || !SET_FLAG.test(code)) return undefined;
  const folded = code
    .replace(FLAG, "export const hydrating = false;")
    .replace(SET_FLAG, "$1");
  // Nothing else in the module may assign it.
  return folded.match(ASSIGNMENT)?.length === 1 ? folded : undefined;
}

function guardHydrate(code: string, plugin: string): string | undefined {
  if (!HYDRATE.test(code)) return undefined;
  return code.replace(
    HYDRATE,
    (open) =>
      `${open} throw new Error(${JSON.stringify(hydrateRemoved(plugin))});`,
  );
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Module `id` of Svelte's client runtime with its hydration code removed,
 * `undefined` for any other module, or a warning when Svelte's source
 * isn't what this expects (it's left as it is).
 */
export function pruneRuntime(
  id: string,
  code: string,
  plugin: string,
): { code: string } | { warning: string } | undefined {
  const file = stripQuery(id);
  const match = RE_RUNTIME_FILE.exec(file);
  if (!match) return undefined;
  const isFlag = match[1] !== "render";
  const client = isFlag ? path.dirname(path.dirname(file)) : path.dirname(file);
  const flag = isFlag ? code : read(path.join(client, "dom", "hydration.js"));
  const render = isFlag ? read(path.join(client, "render.js")) : code;
  const folded = flag === undefined ? undefined : foldFlag(flag);
  const guarded =
    render === undefined ? undefined : guardHydrate(render, plugin);
  if (folded === undefined || guarded === undefined) {
    return {
      warning: `${plugin} left Svelte's hydration code in this build (hydration: false): this version of Svelte's runtime isn't one it can rewrite.`,
    };
  }
  return { code: isFlag ? folded : guarded };
}
