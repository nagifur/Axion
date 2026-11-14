import assert from 'node:assert/strict';
import test from 'node:test';
import { getMissingRequiredFields } from '../src/lib/submissionValidation.ts';

const values = (overrides = {}) => ({
  title: 'Nagi',
  author: 'Creator',
  employeeID: '0001',
  syntheticID: 'SYN-001',
  ...overrides,
});

test('requires a name, author, and employee ID for personnel', () => {
  assert.deepEqual(
    getMissingRequiredFields('personnel', values({ title: ' ', author: '', employeeID: '\t' })),
    [
      { field: 'title', label: 'Name' },
      { field: 'author', label: 'Author / owner credit' },
      { field: 'employeeID', label: 'Employee ID' },
    ],
  );
  assert.deepEqual(getMissingRequiredFields('personnel', values({ syntheticID: '' })), []);
});

test('requires a name, author, and synthetic ID for synthetics', () => {
  assert.deepEqual(
    getMissingRequiredFields('synthetic', values({ title: '', author: '  ', syntheticID: '' })),
    [
      { field: 'title', label: 'Name' },
      { field: 'author', label: 'Author / owner credit' },
      { field: 'syntheticID', label: 'Synthetic ID' },
    ],
  );
  assert.deepEqual(getMissingRequiredFields('synthetic', values({ employeeID: '' })), []);
});

test('requires an entity number and author, but not a separate ID', () => {
  assert.deepEqual(
    getMissingRequiredFields('entity', values({ title: '', author: '', employeeID: '', syntheticID: '' })),
    [
      { field: 'title', label: 'Entity number' },
      { field: 'author', label: 'Author / owner credit' },
    ],
  );
  assert.deepEqual(getMissingRequiredFields('entity', values({ employeeID: '', syntheticID: '' })), []);
});

test('requires a report title and author, but no character ID', () => {
  assert.deepEqual(
    getMissingRequiredFields('article', values({ title: '', author: '', employeeID: '', syntheticID: '' })),
    [
      { field: 'title', label: 'Report title' },
      { field: 'author', label: 'Author / owner credit' },
    ],
  );
  assert.deepEqual(getMissingRequiredFields('article', values({ employeeID: '', syntheticID: '' })), []);
});

test('accepts zero and leading-zero IDs as nonempty text', () => {
  assert.deepEqual(getMissingRequiredFields('personnel', values({ employeeID: '0' })), []);
  assert.deepEqual(getMissingRequiredFields('synthetic', values({ syntheticID: '0009' })), []);
});
