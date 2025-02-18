/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as html from '../ml_parser/ast';
import {ParseError} from '../parse_util';
import {BindingParser} from '../template_parser/binding_parser';

import * as t from './r3_ast';
import {getTriggerParametersStart, parseDeferredTime, parseOnTrigger, parseWhenTrigger} from './r3_deferred_triggers';

/** Pattern to identify a `prefetch when` trigger. */
const PREFETCH_WHEN_PATTERN = /^prefetch\s+when\s/;

/** Pattern to identify a `prefetch on` trigger. */
const PREFETCH_ON_PATTERN = /^prefetch\s+on\s/;

/** Pattern to identify a `minimum` parameter in a block. */
const MINIMUM_PARAMETER_PATTERN = /^minimum\s/;

/** Pattern to identify a `after` parameter in a block. */
const AFTER_PARAMETER_PATTERN = /^after\s/;

/** Pattern to identify a `when` parameter in a block. */
const WHEN_PARAMETER_PATTERN = /^when\s/;

/** Pattern to identify a `on` parameter in a block. */
const ON_PARAMETER_PATTERN = /^on\s/;

/**
 * Predicate function that determines if a block with
 * a specific name cam be connected to a `defer` block.
 */
export function isConnectedDeferLoopBlock(name: string): boolean {
  return name === 'placeholder' || name === 'loading' || name === 'error';
}

/** Creates a deferred block from an HTML AST node. */
export function createDeferredBlock(
    ast: html.Block, connectedBlocks: html.Block[], visitor: html.Visitor,
    bindingParser: BindingParser): {node: t.DeferredBlock, errors: ParseError[]} {
  const errors: ParseError[] = [];
  const {placeholder, loading, error} = parseConnectedBlocks(connectedBlocks, errors, visitor);
  const {triggers, prefetchTriggers} =
      parsePrimaryTriggers(ast.parameters, bindingParser, errors, placeholder);
  const node = new t.DeferredBlock(
      html.visitAll(visitor, ast.children, ast.children), triggers, prefetchTriggers, placeholder,
      loading, error, ast.sourceSpan, ast.startSourceSpan, ast.endSourceSpan);

  return {node, errors};
}

function parseConnectedBlocks(
    connectedBlocks: html.Block[], errors: ParseError[], visitor: html.Visitor) {
  let placeholder: t.DeferredBlockPlaceholder|null = null;
  let loading: t.DeferredBlockLoading|null = null;
  let error: t.DeferredBlockError|null = null;

  for (const block of connectedBlocks) {
    try {
      if (!isConnectedDeferLoopBlock(block.name)) {
        errors.push(new ParseError(block.startSourceSpan, `Unrecognized block "@${block.name}"`));
        break;
      }

      switch (block.name) {
        case 'placeholder':
          if (placeholder !== null) {
            errors.push(new ParseError(
                block.startSourceSpan, `@defer block can only have one @placeholder block`));
          } else {
            placeholder = parsePlaceholderBlock(block, visitor);
          }
          break;

        case 'loading':
          if (loading !== null) {
            errors.push(new ParseError(
                block.startSourceSpan, `@defer block can only have one @loading block`));
          } else {
            loading = parseLoadingBlock(block, visitor);
          }
          break;

        case 'error':
          if (error !== null) {
            errors.push(new ParseError(
                block.startSourceSpan, `@defer block can only have one @error block`));
          } else {
            error = parseErrorBlock(block, visitor);
          }
          break;
      }
    } catch (e) {
      errors.push(new ParseError(block.startSourceSpan, (e as Error).message));
    }
  }

  return {placeholder, loading, error};
}

function parsePlaceholderBlock(ast: html.Block, visitor: html.Visitor): t.DeferredBlockPlaceholder {
  let minimumTime: number|null = null;

  for (const param of ast.parameters) {
    if (MINIMUM_PARAMETER_PATTERN.test(param.expression)) {
      if (minimumTime != null) {
        throw new Error(`@placeholder block can only have one "minimum" parameter`);
      }

      const parsedTime =
          parseDeferredTime(param.expression.slice(getTriggerParametersStart(param.expression)));

      if (parsedTime === null) {
        throw new Error(`Could not parse time value of parameter "minimum"`);
      }

      minimumTime = parsedTime;
    } else {
      throw new Error(`Unrecognized parameter in @placeholder block: "${param.expression}"`);
    }
  }

  return new t.DeferredBlockPlaceholder(
      html.visitAll(visitor, ast.children, ast.children), minimumTime, ast.sourceSpan,
      ast.startSourceSpan, ast.endSourceSpan);
}

function parseLoadingBlock(ast: html.Block, visitor: html.Visitor): t.DeferredBlockLoading {
  let afterTime: number|null = null;
  let minimumTime: number|null = null;

  for (const param of ast.parameters) {
    if (AFTER_PARAMETER_PATTERN.test(param.expression)) {
      if (afterTime != null) {
        throw new Error(`@loading block can only have one "after" parameter`);
      }

      const parsedTime =
          parseDeferredTime(param.expression.slice(getTriggerParametersStart(param.expression)));

      if (parsedTime === null) {
        throw new Error(`Could not parse time value of parameter "after"`);
      }

      afterTime = parsedTime;
    } else if (MINIMUM_PARAMETER_PATTERN.test(param.expression)) {
      if (minimumTime != null) {
        throw new Error(`@loading block can only have one "minimum" parameter`);
      }

      const parsedTime =
          parseDeferredTime(param.expression.slice(getTriggerParametersStart(param.expression)));

      if (parsedTime === null) {
        throw new Error(`Could not parse time value of parameter "minimum"`);
      }

      minimumTime = parsedTime;
    } else {
      throw new Error(`Unrecognized parameter in @loading block: "${param.expression}"`);
    }
  }

  return new t.DeferredBlockLoading(
      html.visitAll(visitor, ast.children, ast.children), afterTime, minimumTime, ast.sourceSpan,
      ast.startSourceSpan, ast.endSourceSpan);
}


function parseErrorBlock(ast: html.Block, visitor: html.Visitor): t.DeferredBlockError {
  if (ast.parameters.length > 0) {
    throw new Error(`@error block cannot have parameters`);
  }

  return new t.DeferredBlockError(
      html.visitAll(visitor, ast.children, ast.children), ast.sourceSpan, ast.startSourceSpan,
      ast.endSourceSpan);
}

function parsePrimaryTriggers(
    params: html.BlockParameter[], bindingParser: BindingParser, errors: ParseError[],
    placeholder: t.DeferredBlockPlaceholder|null) {
  const triggers: t.DeferredBlockTriggers = {};
  const prefetchTriggers: t.DeferredBlockTriggers = {};

  for (const param of params) {
    // The lexer ignores the leading spaces so we can assume
    // that the expression starts with a keyword.
    if (WHEN_PARAMETER_PATTERN.test(param.expression)) {
      parseWhenTrigger(param, bindingParser, triggers, errors);
    } else if (ON_PARAMETER_PATTERN.test(param.expression)) {
      parseOnTrigger(param, triggers, errors, placeholder);
    } else if (PREFETCH_WHEN_PATTERN.test(param.expression)) {
      parseWhenTrigger(param, bindingParser, prefetchTriggers, errors);
    } else if (PREFETCH_ON_PATTERN.test(param.expression)) {
      parseOnTrigger(param, prefetchTriggers, errors, placeholder);
    } else {
      errors.push(new ParseError(param.sourceSpan, 'Unrecognized trigger'));
    }
  }

  return {triggers, prefetchTriggers};
}
