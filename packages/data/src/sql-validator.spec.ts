import { describe, expect, it } from 'vitest';
import { SqlValidationError, SqlValidator } from './sql-validator.js';

describe('SqlValidator', () => {
  const validator = new SqlValidator();

  it('accepts a SELECT and returns its referenced tables', () => {
    const result = validator.validate(
      'SELECT v.id, b.name FROM vehicle v JOIN base b ON b.id = v.base_id',
    );
    expect(result.tables.sort()).toEqual(['base', 'vehicle']);
  });

  it('rejects INSERT', () => {
    expect(() => validator.validate("INSERT INTO vehicle (id) VALUES ('x')")).toThrow(
      SqlValidationError,
    );
  });

  it('rejects UPDATE', () => {
    expect(() => validator.validate("UPDATE vehicle SET name = 'x' WHERE id = 1")).toThrow(
      SqlValidationError,
    );
  });

  it('rejects DELETE', () => {
    expect(() => validator.validate('DELETE FROM vehicle WHERE id = 1')).toThrow(
      SqlValidationError,
    );
  });

  it('rejects a multi-statement string', () => {
    expect(() => validator.validate('SELECT 1; SELECT 2')).toThrow(SqlValidationError);
  });
});
