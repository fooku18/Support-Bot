'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../greet.js');

describe('greet', () => {
  it('greets a name', () => {
    assert.equal(greet('Ada'), 'Hello, Ada!');
  });

  it('handles an empty name', () => {
    assert.equal(greet(''), 'Hello, stranger!');
  });
});
