#!/usr/bin/env bash
# Creates the forge's practice repository (~/deepanvil/forge/sandbox) inside WSL: a tiny,
# dependency-free Node project with tests, so the first real quests can't hurt anything.
# Point the forge at a real project later with DEEPANVIL_REPO=/path/to/repo.
set -euo pipefail
REPO="${1:-$HOME/deepanvil/forge/sandbox}"
if [[ -d "$REPO/.git" ]]; then echo "sandbox already exists at $REPO"; exit 0; fi
mkdir -p "$REPO/src" "$REPO/test"
cd "$REPO"

cat > package.json <<'JSON'
{
  "name": "dwarven-inventory",
  "version": "0.1.0",
  "type": "module",
  "description": "A tiny inventory library for a dwarven forge. Practice ground for Deepanvil.",
  "scripts": { "test": "node --test" }
}
JSON

cat > src/inventory.js <<'JS'
// A dwarven forge's inventory: ingots, tools and finished pieces.

export class Inventory {
  #items = new Map();

  add(name, qty = 1) {
    if (qty <= 0) throw new RangeError('qty must be positive');
    this.#items.set(name, (this.#items.get(name) ?? 0) + qty);
    return this.count(name);
  }

  remove(name, qty = 1) {
    const have = this.count(name);
    if (qty > have) throw new RangeError(`only ${have} ${name} in stock`);
    if (have === qty) this.#items.delete(name);
    else this.#items.set(name, have - qty);
    return this.count(name);
  }

  count(name) {
    return this.#items.get(name) ?? 0;
  }

  list() {
    return [...this.#items.entries()].map(([name, qty]) => ({ name, qty }));
  }
}
JS

cat > test/inventory.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/inventory.js';

test('adds and counts items', () => {
  const inv = new Inventory();
  inv.add('iron ingot', 3);
  assert.equal(inv.count('iron ingot'), 3);
});

test('removes items and refuses to go negative', () => {
  const inv = new Inventory();
  inv.add('hammer');
  assert.equal(inv.remove('hammer'), 0);
  assert.throws(() => inv.remove('hammer'), RangeError);
});
JS

cat > README.md <<'MD'
# Dwarven Inventory

Practice repository for the Deepanvil forge. Run the tests with `npm test`.
MD

git init -q -b main
git -c user.name="Deepanvil" -c user.email="forge@deepanvil.local" add -A
git -c user.name="Deepanvil" -c user.email="forge@deepanvil.local" commit -q -m "Initial inventory library"
echo "sandbox ready at $REPO"
