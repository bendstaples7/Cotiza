// ---------------------------------------------------------------------------
// Formula Evaluator — Recursive-Descent Parser
// ---------------------------------------------------------------------------
// A safe arithmetic expression evaluator that supports:
//   - Numeric literals (integers, decimals)
//   - Variable identifiers [a-zA-Z_][a-zA-Z0-9_]*
//   - Operators: +, -, *, / with standard precedence
//   - Parentheses for grouping
//   - Unary minus
//
// Rejects: function calls, property access, string literals, assignment
// operators, and any non-arithmetic construct.
// ---------------------------------------------------------------------------

export interface FormulaValidationResult {
  valid: boolean;
  error?: string;
  referencedVariables: string[];
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type TokenType =
  | 'number'
  | 'identifier'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'lparen'
  | 'rparen'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < formula.length) {
    const ch = formula[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Numbers: integers and decimals
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < formula.length && formula[i] >= '0' && formula[i] <= '9') {
        i++;
      }
      if (i < formula.length && formula[i] === '.') {
        i++;
        if (i >= formula.length || formula[i] < '0' || formula[i] > '9') {
          throw new FormulaError(`Expected digit after decimal point at position ${i}`);
        }
        while (i < formula.length && formula[i] >= '0' && formula[i] <= '9') {
          i++;
        }
      }
      tokens.push({ type: 'number', value: formula.slice(start, i), position: start });
      continue;
    }

    // Identifiers (variable names)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      while (
        i < formula.length &&
        ((formula[i] >= 'a' && formula[i] <= 'z') ||
          (formula[i] >= 'A' && formula[i] <= 'Z') ||
          (formula[i] >= '0' && formula[i] <= '9') ||
          formula[i] === '_')
      ) {
        i++;
      }
      const value = formula.slice(start, i);

      // Reject if followed by '(' — that's a function call
      if (i < formula.length && formula[i] === '(') {
        throw new FormulaError(
          `Function calls are not allowed — found '${value}(' at position ${start}`,
        );
      }

      // Reject if followed by '.' — that's property access
      if (i < formula.length && formula[i] === '.') {
        throw new FormulaError(
          `Property access is not allowed — found '${value}.' at position ${start}`,
        );
      }

      tokens.push({ type: 'identifier', value, position: start });
      continue;
    }

    // Single-character operators and delimiters
    switch (ch) {
      case '+':
        tokens.push({ type: 'plus', value: ch, position: i });
        i++;
        continue;
      case '-':
        tokens.push({ type: 'minus', value: ch, position: i });
        i++;
        continue;
      case '*':
        tokens.push({ type: 'star', value: ch, position: i });
        i++;
        continue;
      case '/':
        tokens.push({ type: 'slash', value: ch, position: i });
        i++;
        continue;
      case '(':
        tokens.push({ type: 'lparen', value: ch, position: i });
        i++;
        continue;
      case ')':
        tokens.push({ type: 'rparen', value: ch, position: i });
        i++;
        continue;
    }

    // Reject assignment operators
    if (ch === '=') {
      throw new FormulaError(`Assignment operators are not allowed at position ${i}`);
    }

    // Reject string literals
    if (ch === '"' || ch === "'" || ch === '`') {
      throw new FormulaError(`String literals are not allowed at position ${i}`);
    }

    // Reject other characters
    throw new FormulaError(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ type: 'eof', value: '', position: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------
// Grammar:
//   expression  → term (('+' | '-') term)*
//   term        → unary (('*' | '/') unary)*
//   unary       → '-' unary | primary
//   primary     → NUMBER | IDENTIFIER | '(' expression ')'
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos: number;
  public referencedVariables: Set<string> = new Set();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new FormulaError(
        `Expected ${type} but found '${token.value || 'end of formula'}' at position ${token.position}`,
      );
    }
    return this.advance();
  }

  parse(): (variables: Map<string, number>) => number {
    if (this.peek().type === 'eof') {
      throw new FormulaError('Formula cannot be empty');
    }
    const evaluator = this.parseExpression();
    if (this.peek().type !== 'eof') {
      const token = this.peek();
      throw new FormulaError(
        `Unexpected token '${token.value}' at position ${token.position}`,
      );
    }
    return evaluator;
  }

  private parseExpression(): (variables: Map<string, number>) => number {
    let left = this.parseTerm();

    while (this.peek().type === 'plus' || this.peek().type === 'minus') {
      const op = this.advance();
      const right = this.parseTerm();
      const prevLeft = left;
      if (op.type === 'plus') {
        left = (vars) => prevLeft(vars) + right(vars);
      } else {
        left = (vars) => prevLeft(vars) - right(vars);
      }
    }

    return left;
  }

  private parseTerm(): (variables: Map<string, number>) => number {
    let left = this.parseUnary();

    while (this.peek().type === 'star' || this.peek().type === 'slash') {
      const op = this.advance();
      const right = this.parseUnary();
      const prevLeft = left;
      if (op.type === 'star') {
        left = (vars) => prevLeft(vars) * right(vars);
      } else {
        left = (vars) => {
          const divisor = right(vars);
          if (divisor === 0) {
            throw new FormulaError('Division by zero');
          }
          return prevLeft(vars) / divisor;
        };
      }
    }

    return left;
  }

  private parseUnary(): (variables: Map<string, number>) => number {
    if (this.peek().type === 'minus') {
      this.advance();
      const operand = this.parseUnary();
      return (vars) => -operand(vars);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): (variables: Map<string, number>) => number {
    const token = this.peek();

    if (token.type === 'number') {
      this.advance();
      const value = parseFloat(token.value);
      return () => value;
    }

    if (token.type === 'identifier') {
      this.advance();
      const name = token.value;
      this.referencedVariables.add(name);
      return (vars) => {
        if (!vars.has(name)) {
          throw new FormulaError(`Missing variable '${name}'`);
        }
        return vars.get(name)!;
      };
    }

    if (token.type === 'lparen') {
      this.advance();
      const expr = this.parseExpression();
      this.expect('rparen');
      return expr;
    }

    if (token.type === 'eof') {
      throw new FormulaError('Unexpected end of formula');
    }

    throw new FormulaError(
      `Unexpected token '${token.value}' at position ${token.position}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate formula syntax and extract referenced variable names.
 * Does NOT require variable bindings — only checks structure.
 */
export function validateFormula(formula: string): FormulaValidationResult {
  if (!formula || formula.trim().length === 0) {
    return { valid: false, error: 'Formula cannot be empty', referencedVariables: [] };
  }

  try {
    const tokens = tokenize(formula);
    const parser = new Parser(tokens);
    parser.parse();
    return {
      valid: true,
      referencedVariables: Array.from(parser.referencedVariables),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, error: message, referencedVariables: [] };
  }
}

/**
 * Evaluate a formula with the given variable bindings.
 * Returns the numeric result.
 *
 * @throws FormulaError on division by zero, missing variable, non-finite result, or overflow
 */
export function evaluateFormula(formula: string, variables: Map<string, number>): number {
  const tokens = tokenize(formula);
  const parser = new Parser(tokens);
  const evaluator = parser.parse();
  const result = evaluator(variables);

  if (!Number.isFinite(result)) {
    throw new FormulaError('Formula produced a non-finite result');
  }

  if (Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    throw new FormulaError('Formula result exceeds maximum safe integer');
  }

  return result;
}
