'use strict';

/**
 * Fixture greeting helper. Coding tasks implement small behavioral changes
 * here (e.g. `greet(name)`), verified by `npm test` (Node built-in runner,
 * no dependencies).
 *
 * @param {string} name - person to greet
 * @returns {string} greeting text
 */
function greet(name) {
  void name;
  return 'hi';
}

module.exports = { greet };
