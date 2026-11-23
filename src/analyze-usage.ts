import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  lexComponent,
  lexDynamicImports,
  lexImportsExports,
} from "svelte-ast/lexer";
import { extractIdentifiers } from "svelte-ast/walk";

import { forEachNode, type Node, parseModule } from "./ast";
import type { ModuleUsage } from "./call-sites";
import {
  type ComponentModel,
  loadComponentModel,
  loadScriptModel,
  type MirroredStore,
  recheckScriptModels,
} from "./component-model";
import {
  type ContextResolver,
  createScope,
  type EvalScope,
  evaluate,
} from "./evaluate";
import type { Library } from "./library";
import { classTokensOf, isPrefixToken } from "./library-paths";
import { type LiveResult, walkLive } from "./live-walk";
import { listJsAndSvelteFiles, packageSignature } from "./package";
import {
  addCallSite,
  type CallSite,
  checkTarget,
  type ComponentUsage,
  newComponentUsage,
} from "./usage";
import {
  isNullish,
  join,
  possible,
  sameValue,
  shape,
  storeOf,
  UNDEFINED,
  UNKNOWN,
  type Value,
} from "./values";

export type UsageOptions = {
  /** Components that keep every variant, as if rendered with any props. */
  exclude?: string[];
  /**
   * Values for props the analysis can't read, by component then prop;
   * spreads still keep everything.
   */
  assume?: Record<
    string,
    Record<string, Array<string | number | boolean | null>>
  >;
};

export type UsageAnalysis = {
  /** Library module keys that can render. */
  liveComponents: Set<string>;
  usages: Map<string, ComponentUsage>;
  /**
   * `.x--btn--danger` when no button is danger, and every class of a
   * component that can't render.
   */
  isPruned(cls: string): boolean;
  /**
   * Whether library module `key` (`utils/x.js`) can load: something that
   * renders imports it.
   */
  loadable(key: string): boolean;
  /** The scope `key` was last walked in; `undefined` if it can't render. */
  scopeFor(key: string): EvalScope | undefined;
};

type LibrarySources = {
  /** Classes and prefixes the library's script modules name. */
  scriptTokens: Set<string>;
  /** The same, per script module. */
  scriptTokensOf: Map<string, Set<string>>;
  /**
   * Which modules import which, read on first use: only pruning styles needs
   * it.
   */
  graph: () => LibraryModules;
  componentContexts: Set<string>;
  scriptContexts: Set<string>;
  unknownScriptContext: boolean;
  /** A `.js` module reads a context whose key can't be read. */
  scriptReadsContext: boolean;
  /** Keys `.js` modules read, so what they do with each is unseen. */
  scriptContextReads: Set<string>;
};

/**
 * Built-ins a script may call as it loads without running anything of its
 * own: their arguments are checked like the rest.
 */
const BUILTIN_CALLS = new Set([
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Symbol",
  "Symbol.for",
  "Object.freeze",
  "Object.fromEntries",
  "Object.entries",
  "Object.keys",
  "Object.values",
]);

/** Imports that load no script: components, stylesheets, JSON. */
const RE_NOT_SCRIPT = /\.(?:svelte|css|json)$/;
const SET_CONTEXT = /setContext\(\s*["']([^"']+)["']/g;
const GET_CONTEXT = /\bget(?:All)?Contexts?\(/;
/** A `setContext` call whose key isn't a lone string literal. */
const SET_OTHER_CONTEXT = /setContext\(\s*(?!["'][^"']*["']\s*[,)])/;
const librarySourcesCache = new Map<
  string,
  { signature: string; sources: LibrarySources }
>();

async function readLibrarySources(library: Library): Promise<LibrarySources> {
  const signature = await packageSignature(library.root, library.spec.srcDir);
  const cached = librarySourcesCache.get(library.src);
  if (cached?.signature === signature) return cached.sources;
  const sources = await scanLibrarySources(library);
  librarySourcesCache.set(library.src, { signature, sources });
  return sources;
}

/** Reads every module of `library`, uncached. */
export async function scanLibrarySources(
  library: Library,
): Promise<LibrarySources> {
  const { src } = library;
  const sources: LibrarySources = {
    scriptTokens: new Set(),
    scriptTokensOf: new Map(),
    graph: () => {
      throw new Error("unset");
    },
    componentContexts: new Set(),
    scriptContexts: new Set(),
    unknownScriptContext: false,
    scriptReadsContext: false,
    scriptContextReads: new Set(),
  };
  const files = await listJsAndSvelteFiles(src);
  const codes = await Promise.all(
    files.map((file) => readFile(path.join(src, file), "utf8")),
  );
  let graph: LibraryModules | undefined;
  sources.graph = () => {
    graph ??= readModuleGraph(library, files, sources.scriptTokensOf);
    return graph;
  };
  for (const [i, file] of files.entries()) {
    const code = codes[i] ?? "";
    const isScript = file.endsWith(".js");
    if (isScript) {
      const own = new Set<string>();
      classTokensOf(library.spec)?.script(code, own);
      for (const token of own) sources.scriptTokens.add(token);
      if (own.size > 0) sources.scriptTokensOf.set(file, own);
      if (GET_CONTEXT.test(code)) {
        const model = loadScriptModel(src, file);
        if (!model || model.readsUnknownContext) {
          sources.scriptReadsContext = true;
        } else {
          for (const key of model.contextLeaks.keys()) {
            sources.scriptContextReads.add(key);
          }
        }
      }
    }
    for (const match of code.matchAll(SET_CONTEXT)) {
      (isScript ? sources.scriptContexts : sources.componentContexts).add(
        match[1] ?? "",
      );
    }
    if (!SET_OTHER_CONTEXT.test(code)) continue;
    // A module's own model reads keys held in constants, local or
    // imported; any it can't read make it provide every key
    // (`providesUnknownContext`).
    const model = isScript
      ? loadScriptModel(src, file)
      : loadComponentModel(src, file);
    if (isScript && (!model || model.providesUnknownContext)) {
      sources.unknownScriptContext = true;
    }
    for (const key of model?.providedContexts ?? []) {
      (isScript ? sources.scriptContexts : sources.componentContexts).add(key);
    }
  }
  return sources;
}

type LibraryModules = {
  /**
   * Each module's static imports and re-exports of the library's own
   * modules.
   */
  imports: Map<string, Set<string>>;
  /**
   * Modules whose imports can't all be followed (`import(x)`, the barrel,
   * a path outside `src`): reaching one keeps every script's classes.
   */
  opaque: Set<string>;
  /** Scripts with classes that run code as they load: theirs always count. */
  runOnLoad: Set<string>;
};

const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(|import\.meta\.glob/;

function readModuleGraph(
  library: Library,
  files: readonly string[],
  scriptTokensOf: ReadonlyMap<string, Set<string>>,
): LibraryModules {
  const graph: LibraryModules = {
    imports: new Map(),
    opaque: new Set(),
    runOnLoad: new Set(),
  };
  const known = new Set(files);
  for (const file of files) {
    const code = readFileSync(path.join(library.src, file), "utf8");
    readModuleImports(library, file, code, known, graph);
    if (scriptTokensOf.has(file) && runsOnLoad(code)) graph.runOnLoad.add(file);
  }
  return graph;
}

/**
 * Records the library modules `file` imports or re-exports. One with an
 * import it can't follow is opaque.
 */
function readModuleImports(
  library: Library,
  file: string,
  code: string,
  known: ReadonlySet<string>,
  graph: LibraryModules,
): void {
  const imports = new Set<string>();
  graph.imports.set(file, imports);
  let scripts: string[] = [code];
  if (file.endsWith(".svelte")) {
    const { instance, module } = lexComponent(code);
    scripts = [instance, module].flatMap((script) =>
      script ? [code.slice(script.content.start, script.content.end)] : [],
    );
  }
  const follow = (source: string) => {
    if (source === library.name || library.isSpecifier(source)) {
      // The barrel, or a path in the package: anything it reaches.
      graph.opaque.add(file);
      return;
    }
    if (!source.startsWith(".")) return;
    const joined = path.posix.join(path.posix.dirname(file), source);
    const target = [
      joined,
      `${joined}.js`,
      path.posix.join(joined, "index.js"),
    ].find((candidate) => known.has(candidate));
    if (target) imports.add(target);
    else if (!RE_NOT_SCRIPT.test(joined)) graph.opaque.add(file);
  };
  try {
    for (const script of scripts) {
      for (const statement of lexImportsExports(script)) {
        if (statement.source) follow(statement.source.value);
      }
    }
    // Markup can import too: `{#await import("…")}`.
    if (!DYNAMIC_IMPORT.test(code)) return;
    for (const call of lexDynamicImports(code)) {
      if (call.source) follow(call.source.value);
      else graph.opaque.add(file);
    }
  } catch {
    graph.opaque.add(file);
  }
}

/**
 * Whether a script runs code when it loads, outside any function: a
 * statement, or a declaration whose value calls something. Those may apply
 * classes without anything calling them.
 */
function runsOnLoad(code: string): boolean {
  let body: Node[];
  try {
    body = parseModule(code, { comments: false }).body as Node[];
  } catch {
    return true;
  }
  // Names the module declares itself: not the built-ins.
  const own = new Set<string>();
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "ImportDeclaration") {
      for (const { local } of declaration.specifiers) own.add(local.name);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const { id } of declaration.declarations) {
        for (const { name } of extractIdentifiers(id)) own.add(name);
      }
    } else if (
      (declaration?.type === "FunctionDeclaration" ||
        declaration?.type === "ClassDeclaration") &&
      declaration.id
    ) {
      own.add(declaration.id.name);
    }
  }
  const builtin = (callee: Node): boolean => {
    if (callee.type === "Identifier") {
      return BUILTIN_CALLS.has(callee.name) && !own.has(callee.name);
    }
    return (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.property.type === "Identifier" &&
      !own.has(callee.object.name) &&
      BUILTIN_CALLS.has(`${callee.object.name}.${callee.property.name}`)
    );
  };
  const calls = (node: Node | null | undefined) => {
    let found = false;
    forEachNode(node, (inner) => {
      if (
        ((inner.type === "CallExpression" || inner.type === "NewExpression") &&
          !builtin(inner.callee)) ||
        inner.type === "TaggedTemplateExpression"
      ) {
        found = true;
      }
    });
    return found;
  };
  return body.some((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    switch (declaration?.type) {
      case undefined:
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "FunctionDeclaration":
      case "ClassDeclaration":
        return false;
      case "VariableDeclaration":
        return declaration.declarations.some(({ init }) =>
          init &&
          init.type !== "ArrowFunctionExpression" &&
          init.type !== "FunctionExpression"
            ? calls(init)
            : false,
        );
      default:
        return true;
    }
  });
}

/**
 * The library modules that can load: live components (`live`, module
 * keys), scripts that run as they load, and every module they import.
 * `undefined` (any may) when the app imports one of the library's values,
 * or something they reach has an import that can't be followed.
 */
function loadableModules(
  sources: LibrarySources,
  live: Iterable<string>,
  appReadsValues: boolean,
): ReadonlySet<string> | undefined {
  if (appReadsValues) return undefined;
  const graph = sources.graph();
  const seen = new Set<string>();
  const queue = [...live, ...graph.runOnLoad];
  for (const key of queue) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (graph.opaque.has(key)) return undefined;
    for (const next of graph.imports.get(key) ?? []) queue.push(next);
  }
  return seen;
}

/**
 * Per key: `undefined` (no provider above) or a provider's object, with
 * stores no reader can set.
 */
type ContextValues = Map<string, Value>;

/** Rounds after which context values stop flowing, so the fixpoint ends. */
const MAX_CONTEXT_ROUNDS = 16;

/**
 * A `MirroredStore` property flows only when read-only or no rendered
 * component leaks it.
 */
function contextValues(
  modelOf: (key: string) => ComponentModel,
  usages: Map<string, ComponentUsage>,
  resolver: ContextResolver,
  svelteMajor: number | undefined,
  scriptReads: ReadonlySet<string>,
): ContextValues {
  const values: ContextValues = new Map();
  const leaks = new Map<string, Set<string>>();
  for (const key of scriptReads) leaks.set(key, new Set(["*"]));
  for (const key of usages.keys()) {
    const model = modelOf(key);
    if (model.readsUnknownContext) return values;
    for (const [contextKey, leaked] of model.contextLeaks) {
      const all = leaks.get(contextKey) ?? new Set<string>();
      for (const property of leaked) all.add(property);
      leaks.set(contextKey, all);
    }
  }
  const unflowable = new Set<string>();
  for (const [key, usage] of usages) {
    const model = modelOf(key);
    if (model.contextObjects.size === 0) continue;
    const scope = createScope(model, usage, resolver, { svelteMajor });
    for (const [contextKey, objects] of model.contextObjects) {
      const leaked = leaks.get(contextKey);
      if (!objects.every((object) => object !== null)) {
        unflowable.add(contextKey);
        continue;
      }
      // Handed to a provider above: it may change what's in it.
      if (
        objects.some((object) =>
          object?.unlessProvided.some((key) => {
            const provided = resolver(key);
            return provided === UNKNOWN || ![...provided].every(isNullish);
          }),
        )
      ) {
        unflowable.add(contextKey);
        continue;
      }
      let value = values.get(contextKey) ?? UNDEFINED;
      for (const object of objects) {
        const props = new Map<string, Value>();
        for (const [property, mirrored] of object.properties) {
          // A store the object holds twice flows only if no holder leaks.
          const flows =
            mirrored &&
            ((mirrored.readOnly && mirrored.aliases.length === 0) ||
              ![property, ...mirrored.aliases].some(
                (name) => leaked?.has("*") || leaked?.has(name),
              ));
          props.set(property, flows ? storeValue(mirrored, scope) : UNKNOWN);
        }
        value = join(value, possible(shape({ kind: "object", props })));
      }
      values.set(contextKey, value);
    }
  }
  for (const key of unflowable) values.delete(key);
  return values;
}

function storeValue(mirrored: MirroredStore, scope: EvalScope): Value {
  let value = mirrored.initial ? evaluate(mirrored.initial, scope) : UNDEFINED;
  for (const write of mirrored.writes) {
    value = join(value, evaluate(write, scope));
  }
  return storeOf(value);
}

function sameValues(a: ContextValues, b: ContextValues): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || !sameValue(value, other)) return false;
  }
  return true;
}

type ProvidedContexts = {
  keys: Set<string>;
  /** Some rendered component's `setContext` key can't be read. */
  unknown: boolean;
  values: ContextValues;
};

type Pass = {
  usages: Map<string, ComponentUsage>;
  resolver: ContextResolver;
  /** What each component's walk with its joined usage found. */
  live: Map<string, LiveResult>;
  /** Each component's call sites, as its usage joined them. */
  sites: Map<string, CallSite[]>;
};

/**
 * The classes and prefixes the rendered components can apply. The joined
 * usage lets values from different call sites meet (one site's
 * `iconDescription`, another's `portalTooltip`); every instance comes from
 * one site, so a component with several is walked once per site.
 */
function passClasses(
  pass: Pass,
  modelOf: (key: string) => ComponentModel,
  library: Library,
): { classes: Set<string>; prefixes: Set<string> } {
  const { svelteMajor } = library;
  const classes = new Set<string>();
  const prefixes = new Set<string>();
  const add = (result: LiveResult) => {
    for (const cls of result.classes) classes.add(cls);
    for (const prefix of result.prefixes) prefixes.add(prefix);
  };
  for (const [key, own] of pass.sites) {
    const joined = pass.live.get(key);
    if (own.length === 1 && joined) {
      add(joined);
      continue;
    }
    const model = modelOf(key);
    for (const site of own) {
      const usage = newComponentUsage();
      addCallSite(usage, site, model.propNames.values(), svelteMajor);
      add(
        walkLive(
          createScope(model, usage, pass.resolver, { svelteMajor }),
          library,
        ),
      );
    }
  }
  return { classes, prefixes };
}

function runPass(
  modelOf: (key: string) => ComponentModel,
  roots: readonly CallSite[],
  context: (provided: ProvidedContexts) => ContextResolver,
  excluded: ReadonlySet<string>,
  flowContexts: boolean,
  scriptContextReads: ReadonlySet<string>,
  library: Library,
): Pass {
  const { svelteMajor } = library;
  let provided: ProvidedContexts = {
    keys: new Set(),
    unknown: false,
    values: new Map(),
  };
  for (let round = 0; ; round++) {
    const usages = new Map<string, ComponentUsage>();
    const live = new Map<string, LiveResult>();
    const sites = new Map<string, CallSite[]>();
    // A component queued twice is walked once, with its usage as it is then.
    const queue = new Set<string>();
    const resolver = context(provided);

    const enqueue = (site: CallSite) => {
      const model = modelOf(site.component);
      let usage = usages.get(site.component);
      if (!usage) {
        usage = newComponentUsage();
        usages.set(site.component, usage);
      }
      // Excluded wherever it renders, the library's own call sites included.
      if (excluded.has(site.component) && !site.open) {
        site = { ...site, open: true, reason: "excluded" };
      }
      site = checkTarget(site, model);
      let own = sites.get(site.component);
      if (!own) {
        own = [];
        sites.set(site.component, own);
      }
      own.push(site);
      if (addCallSite(usage, site, model.propNames.values(), svelteMajor)) {
        queue.add(site.component);
      }
    };

    for (const site of roots) enqueue(site);
    for (const key of queue) {
      queue.delete(key);
      const model = modelOf(key);
      const usage = usages.get(key);
      if (!usage) continue;
      const result = walkLive(
        createScope(model, usage, resolver, { svelteMajor }),
        library,
      );
      live.set(key, result);
      for (const site of result.childSites) enqueue(site);
    }

    // `getContext` reads `undefined` unless a rendered component provides
    // it. Rendering more can provide more, so repeat until that settles.
    const next: ProvidedContexts = {
      keys: new Set(provided.keys),
      unknown: provided.unknown,
      values:
        flowContexts && round < MAX_CONTEXT_ROUNDS
          ? contextValues(
              modelOf,
              usages,
              resolver,
              svelteMajor,
              scriptContextReads,
            )
          : new Map<string, Value>(),
    };
    for (const key of usages.keys()) {
      const model = modelOf(key);
      for (const contextKey of model.providedContexts) {
        next.keys.add(contextKey);
      }
      next.unknown ||= model.providesUnknownContext;
    }
    if (
      next.keys.size === provided.keys.size &&
      next.unknown === provided.unknown &&
      sameValues(provided.values, next.values)
    ) {
      return { usages, resolver, live, sites };
    }
    provided = next;
  }
}

function startsWithAny(cls: string, prefixes: Iterable<string>): boolean {
  for (const prefix of prefixes) if (cls.startsWith(prefix)) return true;
  return false;
}

/**
 * A class the walk doesn't see in what renders (and no `.js` module names)
 * can't be applied. Throws if a component can't be modeled.
 */
export async function analyzeUsage(input: {
  library: Library;
  bundled: Iterable<string>;
  modules: Iterable<ModuleUsage>;
  options?: UsageOptions;
}): Promise<UsageAnalysis> {
  const { library } = input;
  recheckScriptModels();
  const sources = await readLibrarySources(library);
  const options = input.options ?? {};
  // Each model once per analysis: `loadComponentModel` checks the file's
  // mtime, and the passes ask for the same models thousands of times.
  const models = new Map<string, ComponentModel>();
  const modelOf = (key: string): ComponentModel => {
    let model = models.get(key);
    if (!model) {
      model = loadComponentModel(library.src, key);
      models.set(key, model);
    }
    return model;
  };

  const excluded = new Set(
    (options.exclude ?? []).flatMap((name) => {
      const key = library.components.get(name);
      return key ? [key] : [];
    }),
  );
  const assumed = new Map<string, Map<string, Value>>();
  for (const [name, props] of Object.entries(options.assume ?? {})) {
    const key = library.components.get(name);
    if (!key) continue;
    assumed.set(
      key,
      new Map(
        Object.entries(props).map(([prop, values]) => [
          prop,
          possible(...values),
        ]),
      ),
    );
  }

  const roots: CallSite[] = [];
  const appContexts = new Set<string>();
  let appProvidesUnknown = false;
  let appReadsContext = false;
  let openAll = false;
  let appReadsValues = false;
  for (const module of input.modules) {
    openAll ||= module.openAll;
    appReadsValues ||=
      module.openAll ||
      module.libraryValues === "any" ||
      (module.libraryValues?.size ?? 0) > 0;
    for (const key of module.providedContexts) appContexts.add(key);
    appProvidesUnknown ||= module.providesUnknownContext === true;
    appReadsContext ||= module.readsLibraryContext === true;
    for (const site of module.sites) {
      const assumptions = assumed.get(site.component);
      if (assumptions && !site.open) {
        const props = new Map(site.props);
        for (const [prop, value] of assumptions) {
          if (props.get(prop) === UNKNOWN) props.set(prop, value);
        }
        roots.push({ ...site, props });
      } else {
        roots.push(site);
      }
    }
  }
  if (openAll) {
    for (const key of input.bundled) {
      roots.push({ component: key, open: true, props: new Map(), slots: null });
    }
  }

  const unknownKeys = appProvidesUnknown || sources.unknownScriptContext;
  const precise = runPass(
    modelOf,
    roots,
    (provided) => (key) => {
      if (
        provided.unknown ||
        unknownKeys ||
        appContexts.has(key) ||
        sources.scriptContexts.has(key) ||
        // A key set some way this scan can't see (a constant, a helper).
        !sources.componentContexts.has(key)
      ) {
        return UNKNOWN;
      }
      if (!provided.keys.has(key)) return UNDEFINED;
      return provided.values.get(key) ?? UNKNOWN;
    },
    excluded,
    !sources.scriptReadsContext && !appReadsContext,
    sources.scriptContextReads,
    library,
  );

  // Only scripts something that renders can load may apply their classes.
  // Worked out on first use: only pruning styles asks.
  let loadable: ReadonlySet<string> | undefined | null = null;
  const loadableNow = () => {
    if (loadable === null) {
      loadable = loadableModules(
        sources,
        precise.usages.keys(),
        appReadsValues,
      );
    }
    return loadable;
  };
  let scripts: { tokens: ReadonlySet<string>; prefixes: string[] } | undefined;
  const scriptClasses = () => {
    if (scripts) return scripts;
    const reached = loadableNow();
    let tokens: ReadonlySet<string> = sources.scriptTokens;
    if (reached) {
      const own = new Set<string>();
      for (const key of reached) {
        for (const token of sources.scriptTokensOf.get(key) ?? []) {
          own.add(token);
        }
      }
      tokens = own;
    }
    scripts = {
      tokens,
      prefixes: [...tokens].filter(isPrefixToken),
    };
    return scripts;
  };
  const verdicts = new Map<string, boolean>();
  // Only what prunes styles asks; a rewrite never walks each site.
  let rendered: ReturnType<typeof passClasses> | undefined;
  const isPruned = (cls: string): boolean => {
    let verdict = verdicts.get(cls);
    if (verdict === undefined) {
      rendered ??= passClasses(precise, modelOf, library);
      // The index also lists classes a component's CSS targets
      // (`.x--date-picker` for every input DatePicker wraps); those can't
      // render unless their own component is live.
      verdict =
        !rendered.classes.has(cls) &&
        !startsWithAny(cls, rendered.prefixes) &&
        !scriptClasses().tokens.has(cls) &&
        !startsWithAny(cls, scriptClasses().prefixes);
      verdicts.set(cls, verdict);
    }
    return verdict;
  };

  return {
    liveComponents: new Set(precise.usages.keys()),
    usages: precise.usages,
    isPruned,
    loadable: (key) => loadableNow()?.has(key) ?? true,
    scopeFor(key) {
      const usage = precise.usages.get(key);
      return usage
        ? createScope(modelOf(key), usage, precise.resolver, {
            svelteMajor: library.svelteMajor,
          })
        : undefined;
    },
  };
}
