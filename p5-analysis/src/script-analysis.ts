import { Program } from 'esprima';
import {
  ArrowFunctionExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MethodDefinition,
  Pattern,
  PropertyDefinition,
  Statement
} from 'estree';
import { ESTreeVisitor } from './ESTreeVisitor';

export function findGlobals(program: Program) {
  return new Map<string, string>(iterProgram());
  function* iterProgram(): Iterable<[string, string]> {
    for (const { name, nodeType } of new DeclarationIterator(program).visit()) {
      yield [name, nodeType];
    }
  }
}

export function findFreeVariables(program: Program): Set<string> {
  return new Set(iterProgram(program));
  function* iterProgram(program: Program): Iterable<string> {
    yield* new FreeVariableIterator(program).visit();
  }
}

// This does not recurse inside function bodies. It only collects the
// top-level ids.
type DeclarationIteratorIterationType = Iterable<{
  name: string;
  nodeType: string;
}>;

class DeclarationIterator extends ESTreeVisitor<{
  name: string;
  nodeType: string;
}> {
  *iterProgram(program: Program): DeclarationIteratorIterationType {
    for (const stmt of program.body) {
      switch (stmt.type) {
        case 'ClassDeclaration':
        case 'FunctionDeclaration':
        case 'VariableDeclaration':
          yield* this.visitStatement(stmt);
          break;
        default:
        // ignore other node types
      }
    }
  }

  *visitStatement(node: Statement): DeclarationIteratorIterationType {
    switch (node.type) {
      case 'ClassDeclaration':
      case 'FunctionDeclaration':
        if (node.id) {
          yield { name: node.id.name, nodeType: node.type };
        }
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          for (const { name } of this.visitPattern(decl.id)) {
            yield { name, nodeType: node.type };
          }
        }
        break;
      default:
      // ignore other node types
    }
  }

  *visitPattern(node: Pattern) {
    switch (node.type) {
      case 'Identifier':
        yield { name: node.name, nodeType: node.type };
        break;
      default:
        yield* ESTreeVisitor.prototype.visitPattern.call(this, node);
        break;
    }
  }
}

class FreeVariableIterator extends ESTreeVisitor<string> {
  *visitProgram(program: Program): Iterable<string> {
    const globalVariables = new Set(findGlobals(program).keys());
    for (const name of ESTreeVisitor.prototype.visitProgram.call(this, program)) {
      if (!globalVariables.has(name)) {
        yield name;
      }
    }
  }

  *visitStatement(node: Statement): Iterable<string> {
    switch (node.type) {
      case 'FunctionDeclaration':
        yield* this.visitBaseFunction(node, node.id);
        break;
      case 'ForStatement': {
        const locals = new Set<string>();
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') {
            for (const decl of node.init.declarations) {
              if (decl.init) yield* this.visitExpression(decl.init);
              for (const name of this.visitPattern(decl.id)) {
                locals.add(name);
              }
            }
          } else {
            yield* this.visitExpression(node.init);
          }
        }
        const that = this;
        yield* this.filterLocals(locals, function*() {
          if (node.test) {
            yield* that.visitExpression(node.test);
          }
          if (node.update) {
            yield* that.visitExpression(node.update);
          }
          yield* that.visitStatement(node.body);
        });
        break;
      }
      case 'ForInStatement':
        // FIXME: build local context
        // TODO: yield* iterExpression(node.left);
        yield* this.visitExpression(node.right);
        yield* this.visitStatement(node.body);
        break;
      case 'ForOfStatement':
        // FIXME: build local context
        // TODO: yield* iterExpression(node.left);
        yield* this.visitExpression(node.right);
        yield* this.visitStatement(node.body);
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          if (decl.init) {
            yield* this.visitExpression(decl.init);
          }
        }
        break;
      default:
        yield* ESTreeVisitor.prototype.visitStatement.call(this, node);
        break;
    }
    // TODO: Declaration | ImportExpression
    // TODO: note binding in TryStatement
  }

  *visitExpression(node: Expression): Iterable<string> {
    switch (node.type) {
      case 'ArrowFunctionExpression':
        yield* this.visitBaseFunction(node);
        break;
      case 'FunctionExpression':
        yield* this.visitBaseFunction(node);
        break;
      case 'Identifier':
        yield node.name;
        break;
      default:
        yield* ESTreeVisitor.prototype.visitExpression.call(this, node);
        break;
    }
  }

  *iterDeclaredNames(node: Statement): Iterable<string> {
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) {
          yield node.id.name;
        }
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          yield* this.visitPattern(decl.id);
          break;
        }
    }
  }

  *visitDefinition(node: MethodDefinition | PropertyDefinition) {
    if (node.type === 'MethodDefinition') {
      yield* this.visitExpression(node.value);
    } else {
      yield* ESTreeVisitor.prototype.visitDefinition.call(this, node);
    }
  }

  *visitPattern(node: Pattern): Iterable<string> {
    switch (node.type) {
      case 'Identifier':
        yield node.name;
        break;
      default:
        yield* ESTreeVisitor.prototype.visitPattern.call(this, node);
        break;
    }
  }

  *visitBaseFunction(
    node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    id?: Identifier | null
  ): Iterable<string> {
    const locals = new Set<string>();
    if (id) {
      locals.add(id.name);
    }
    for (const param of node.params) {
      for (const name of this.visitPattern(param)) {
        locals.add(name);
      }
    }
    const that = this;
    yield* this.filterLocals(locals, function*() {
      if (node.body.type === 'BlockStatement') {
        for (const block of node.body.body) {
          for (const name of that.iterDeclaredNames(block)) {
            locals.add(name);
          }
          yield* that.visitStatement(block);
        }
      } else {
        yield* that.visitExpression(node.body);
      }
    });
  }

  *filterLocals(locals: Set<string>, iter: () => Iterable<string>): Iterable<string> {
    for (const name of iter()) {
      if (!locals.has(name)) {
        yield name;
      }
    }
  }
}

export function findP5PropertyReferences(program: Program): Set<string> {
  return new Set(iterProgram(program));

  function* iterProgram(program: Program): Iterable<string> {
    yield* new PropertyMemberIterator(program).visit();
  }
}

class PropertyMemberIterator extends ESTreeVisitor<string> {
  *visitExpression(node: Expression): Iterable<string> {
    if (node.type === 'MemberExpression') {
      if (node.object.type === 'Identifier' && node.object.name === 'p5' && node.property.type === 'Identifier') {
        yield node.property.name;
      }
    }
    yield* ESTreeVisitor.prototype.visitExpression.call(this, node);
  }
}

export function findLoadCalls(program: Program) {
  return new Set(iterProgram(program));

  function* iterProgram(program: Program): Iterable<string> {
    yield* new LoadCallIterator(program).visit();
  }
}

class LoadCallIterator extends ESTreeVisitor<string> {
  *visitExpression(node: Expression): Iterable<string> {
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && node.callee.name.startsWith('load') && node.arguments.length >= 1) {
        const arg = node.arguments[0];
        if (arg.type === 'Literal' && typeof arg.value === 'string') {
          yield arg.value;
        }
      }
    }
    yield* ESTreeVisitor.prototype.visitExpression.call(this, node);
  }
}
