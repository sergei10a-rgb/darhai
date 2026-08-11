/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capability frames must survive the msg_id guard.
 *
 * `WCoreManager` drops every stream frame with no `msg_id`, because a frame
 * outside a turn would otherwise put the chat into a false "working" state.
 * But engine capabilities report facts about the SESSION - a policy revision, a
 * workflow run, an audit receipt - and legitimately carry no msg_id. Three
 * earlier features (sub_agent_event, mcp_failed, config_changed) each bought
 * their own hand-written exemption above that guard; nine more would repeat the
 * block nine times and guarantee the tenth is forgotten.
 *
 * So the exemption is derived from the capability registry itself. These tests
 * pin that derivation, because its failure mode is silent: the frame is dropped
 * and the capability merely looks unimplemented.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { forwardableFrameTypes, registeredCapabilities } from '@process/agent/wcore/capabilities';

const MANAGER_SRC = readFileSync(join(process.cwd(), 'src/process/task/WCoreManager.ts'), 'utf-8');

describe('capability frames bypass the msg_id guard', () => {
  it('the exemption set is built from the registry, not hand-written', () => {
    expect(MANAGER_SRC).toContain('new Set(forwardableFrameTypes())');
  });

  /**
   * Order is the whole point: an exemption placed after `if (!data.msg_id)
   * return;` would never run. This asserts the relative position in the source
   * because the alternative - booting a manager and a fake engine - would test
   * far more than the one line at issue.
   */
  it('the exemption is checked BEFORE the guard that would drop it', () => {
    const exemption = MANAGER_SRC.indexOf('CAPABILITY_FRAME_TYPES.has(data.type)');
    const guard = MANAGER_SRC.indexOf('if (!data.msg_id) return;');
    expect(exemption, 'exemption not found').toBeGreaterThan(-1);
    expect(guard, 'msg_id guard not found').toBeGreaterThan(-1);
    expect(exemption).toBeLessThan(guard);
  });

  it('forwards the frame with its own type rather than flattening to info', () => {
    // The renderer routes on `type`; collapsing every capability frame into an
    // `info` line would make them indistinguishable and unstylable.
    const block = MANAGER_SRC.slice(
      MANAGER_SRC.indexOf('CAPABILITY_FRAME_TYPES.has(data.type)'),
      MANAGER_SRC.indexOf('if (!data.msg_id) return;')
    );
    expect(block).toContain('type: data.type');
    expect(block).toContain('conversation_id: this.conversation_id');
  });

  it('every registered capability’s claimed AND emitted types are forwarded', () => {
    // The registry is the single source; this fails the moment someone
    // introduces a parallel hand-kept list.
    const forwarded = new Set(forwardableFrameTypes());
    for (const capability of registeredCapabilities()) {
      for (const type of capability.handles) {
        expect(forwarded.has(type), `${capability.name} handles "${type}" but it is not forwarded`).toBe(true);
      }
      for (const type of capability.emits ?? []) {
        expect(forwarded.has(type), `${capability.name} emits "${type}" but it is not forwarded`).toBe(true);
      }
    }
  });

  /**
   * The gap this whole seam exists to close. Two capabilities project several
   * wire events into ONE frame under a name they never consume - workflow
   * lifecycle emits `workflow_run`, anvil emits `anvil_receipt_alert`. Keying
   * the exemption on `handles` alone dropped both: the capability worked, its
   * tests passed, and nothing reached the user.
   */
  it('forwards projection frames whose name is not a consumed event', () => {
    const forwarded = new Set(forwardableFrameTypes());
    for (const projection of ['workflow_run', 'anvil_receipt_alert']) {
      expect(forwarded.has(projection), `${projection} would be dropped by the msg_id guard`).toBe(true);
    }
  });

  it('derives the set from the registry rather than a hand-kept list', () => {
    expect(MANAGER_SRC).toContain('capability registry');
  });
});

/**
 * The mechanical guard.
 *
 * The rule - "a capability must emit under a type the forward set knows" - was
 * first asserted by checking that a COMMENT phrase existed in another file.
 * That test passed while `workflow_run` and `anvil_receipt_alert` were being
 * dropped on every turn, and would have kept passing for a tenth capability
 * repeating the mistake.
 *
 * Its replacement was a regex over the handler sources, and it inherited the
 * same failure mode for a different reason. `/ctx\.emit\(\{[^)]*?\btype:/`
 * cannot cross a `)` inside the object literal, so moving `type:` after
 * `data: project(run)` made the scan find ZERO emitted types in a file that
 * emits two - green, silently, with the frame no longer forwardable. And
 * `\btype:` never matched the shorthand `ctx.emit({ type, data, msg_id: '' })`,
 * which is the form two handlers use today.
 *
 * So the scan parses. Key order is irrelevant to a parser, shorthand is just
 * another property, and a type that arrives through a parameter is followed to
 * the call sites that supply it. The counting assertion below is the part that
 * makes it a guard rather than a best effort: a `ctx.emit` the scan could not
 * read a type out of is a FAILURE, because "found nothing" is exactly what both
 * previous versions did on the day they were wrong.
 */
describe('every emitted frame type is forwardable (source scan)', () => {
  const HANDLER_DIR = join(process.cwd(), 'src/process/agent/wcore/capabilities/handlers');

  /** One `ctx.emit(...)` call site and what the scan could make of its `type`. */
  type EmitSite = {
    line: number;
    text: string;
    /** Every frame type this call can emit, or null when none could be read. */
    types: string[] | null;
  };

  /** How many parameter hops to follow before giving up. */
  const MAX_HOPS = 6;

  /**
   * Read every frame type a handler file can emit.
   *
   * Resolution order for the `type` property, all of which appear in the tree:
   * a string literal; a module constant; a parameter whose annotation is a
   * union of string literals; a parameter whose values come from the call
   * sites of its own function (followed recursively - the diagnostics handler
   * passes a type through two hops before it reaches `ctx.emit`).
   *
   * Deliberately no CROSS-FILE resolution: a frame name defined in another
   * module is exactly the indirection this guard should force an author to
   * avoid, and it would be reported as unreadable rather than passed.
   */
  function scanEmits(fileName: string, source: string): EmitSite[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

    const stringConsts = new Map<string, string>();
    const collectConsts = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) stringConsts.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, collectConsts);
    };
    collectConsts(sf);

    const callsTo = (name: string): ts.CallExpression[] => {
      const found: ts.CallExpression[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
          found.push(node);
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      return found;
    };

    type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
    const enclosingFunction = (node: ts.Node): FnLike | null => {
      for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
        if (
          ts.isFunctionDeclaration(cur) ||
          ts.isFunctionExpression(cur) ||
          ts.isArrowFunction(cur) ||
          ts.isMethodDeclaration(cur)
        ) {
          return cur;
        }
      }
      return null;
    };

    /** String literals named by a type annotation, e.g. `'a' | 'b'`. */
    const literalsOfTypeNode = (type: ts.TypeNode | undefined): string[] | null => {
      if (!type) return null;
      const one = (t: ts.TypeNode): string | null =>
        ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null;
      if (ts.isUnionTypeNode(type)) {
        const parts = type.types.map(one);
        return parts.every((p): p is string => p !== null) ? parts : null;
      }
      const single = one(type);
      return single === null ? null : [single];
    };

    const resolve = (expr: ts.Node, hops: number, seen: ReadonlySet<string>): string[] | null => {
      if (hops > MAX_HOPS) return null;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
      if (ts.isConditionalExpression(expr)) {
        const yes = resolve(expr.whenTrue, hops + 1, seen);
        const no = resolve(expr.whenFalse, hops + 1, seen);
        return yes && no ? [...yes, ...no] : null;
      }
      if (!ts.isIdentifier(expr)) return null;

      const asConst = stringConsts.get(expr.text);
      if (asConst !== undefined) return [asConst];

      const fn = enclosingFunction(expr);
      if (!fn) return null;
      const index = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === expr.text);
      if (index < 0) return null;

      const declared = literalsOfTypeNode(fn.parameters[index].type);
      if (declared) return declared;

      // The parameter is typed loosely (`string`). Its real values are whatever
      // the call sites pass, so follow those - guarding against a function that
      // reaches itself, which would otherwise recurse until the hop cap.
      const fnName = ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : '';
      if (!fnName || seen.has(fnName)) return null;
      const sites = callsTo(fnName);
      if (sites.length === 0) return null;
      const nextSeen = new Set([...seen, fnName]);
      const collected: string[] = [];
      for (const site of sites) {
        const arg = site.arguments[index];
        const resolved = arg ? resolve(arg, hops + 1, nextSeen) : null;
        if (!resolved) return null;
        collected.push(...resolved);
      }
      return collected;
    };

    const sites: EmitSite[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'emit'
      ) {
        const arg = node.arguments[0];
        let types: string[] | null = null;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            const named = prop.name && ts.isIdentifier(prop.name) && prop.name.text === 'type';
            if (ts.isPropertyAssignment(prop) && named) types = resolve(prop.initializer, 0, new Set());
            // `{ type, data, msg_id }` - the form the previous regex could not see.
            else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'type') {
              types = resolve(prop.name, 0, new Set());
            }
          }
        }
        sites.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          text: node.getText(sf).split('\n')[0].trim(),
          types: types && types.length > 0 ? [...new Set(types)] : null,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return sites;
  }

  const files = readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.ts'));

  it('finds handler sources to scan', () => {
    // A scan over zero files is green and worthless. Nine capabilities are
    // registered; the directory must hold at least that many modules.
    expect(files.length).toBeGreaterThanOrEqual(registeredCapabilities().length);
  });

  it.each(files)('%s emits only types WCoreManager will forward', (file) => {
    const sites = scanEmits(file, readFileSync(join(HANDLER_DIR, file), 'utf-8'));
    const forwarded = new Set(forwardableFrameTypes());
    for (const site of sites) {
      for (const type of site.types ?? []) {
        expect(
          forwarded.has(type),
          `${file}:${site.line} emits "${type}" but it is not in forwardableFrameTypes() - ` +
            `WCoreManager drops it before the renderer. Add it to the handler's ` +
            `\`handles\` or \`emits\`.`
        ).toBe(true);
      }
    }
  });

  /**
   * The counting half, and the reason the previous two versions of this guard
   * were worthless: both answered "no emitted types" for a file that emits, and
   * an empty answer is indistinguishable from a clean one unless it is a
   * failure in its own right.
   */
  it.each(files)('%s: the scan reads a frame type out of every ctx.emit call', (file) => {
    const source = readFileSync(join(HANDLER_DIR, file), 'utf-8');
    const sites = scanEmits(file, source);

    // The parser and a dumb text count must agree on HOW MANY emit calls exist,
    // or the walk is skipping call sites rather than failing to read them.
    const textual = (source.match(/ctx\.emit\(/g) ?? []).length;
    expect(sites.length, `${file}: the AST walk found ${sites.length} ctx.emit calls, the text has ${textual}`).toBe(
      textual
    );

    const unreadable = sites.filter((s) => s.types === null);
    expect(
      unreadable,
      `${file}: no frame type could be read from ${unreadable.length} ctx.emit call(s) - ` +
        `${unreadable.map((s) => `line ${s.line}: ${s.text}`).join('; ')}. ` +
        `An emit the guard cannot read is an emit it cannot check.`
    ).toEqual([]);
  });

  /**
   * The guard on the guard.
   *
   * A scan that has quietly stopped resolving anything passes every file above,
   * because "found nothing" reads as "found nothing wrong". These feed the
   * scanner crafted sources - including the exact mutation that defeated the
   * regex - and assert what it makes of each, so the scan keeps proving it can
   * still see, on every run, without touching a handler.
   */
  describe('the scan itself still works', () => {
    const typesOf = (source: string): Array<string[] | null> => scanEmits('probe.ts', source).map((s) => s.types);

    it('reads the type wherever it sits in the object literal', () => {
      // The mutation that turned the regex green: `type:` moved after a
      // property whose value contains a `)`.
      expect(typesOf(`const F = 'workflow_run';\nctx.emit({ data: project(run), type: F, msg_id: '' });`)).toEqual([
        ['workflow_run'],
      ]);
    });

    it('reads a shorthand type property', () => {
      // durableGoals and runtimeDiagnostics both emit in this form; `\\btype:`
      // matched neither.
      const source = `function announce(ctx: C, type: 'goal_snapshot' | 'goal_transition', frame: F): void {
  ctx.emit({ type, data: frame, msg_id: '' });
}`;
      expect(typesOf(source)).toEqual([['goal_snapshot', 'goal_transition']]);
    });

    it('follows a loosely typed parameter to the call sites that supply it', () => {
      const source = `function emitFrame(ctx: C, type: string, data: D): void {
  ctx.emit({ type, data, msg_id: '' });
}
function a(ctx: C): void { emitFrame(ctx, 'runtime_diagnostics_snapshot', {}); }
function b(ctx: C): void { emitFrame(ctx, 'mcp_removal_result', {}); }`;
      expect(typesOf(source)).toEqual([['runtime_diagnostics_snapshot', 'mcp_removal_result']]);
    });

    it('reports an emit whose type it cannot read, instead of skipping it', () => {
      expect(typesOf(`ctx.emit({ data, msg_id: '' });`)).toEqual([null]);
      expect(typesOf(`ctx.emit({ type: pickType(event), data, msg_id: '' });`)).toEqual([null]);
      expect(typesOf(`ctx.emit({ ...frame, msg_id: '' });`)).toEqual([null]);
    });

    it('counts every emit call, including ones nested inside other calls', () => {
      const source = `const A = 'x';\nfunction f(ctx: C): void {\n  wrap(() => ctx.emit({ type: A, data: g(1), msg_id: '' }));\n  ctx.emit({ type: 'y', data: 0, msg_id: '' });\n}`;
      expect(typesOf(source)).toEqual([['x'], ['y']]);
    });
  });
});
