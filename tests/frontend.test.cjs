'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() { this.children = []; this.textContent = ''; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
}
function client(fetch) {
  const nodes = new Map();
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement() { return new Element(); },
  };
  const context = vm.createContext({ window: {}, document, fetch, URLSearchParams, setTimeout, clearTimeout });
  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext("state.step = 3; state.service = {id: 1, price_amd: 6000}; state.day = '2026-10-13'; state.time = '12:00';", context);
  return { context, nodes };
}
const response = slots => ({ ok: true, json: async () => ({ slots }) });

test('a selected time cannot advance during refresh and is cleared when no slots remain', async () => {
  let complete;
  const { context, nodes } = client(() => new Promise(resolve => { complete = resolve; }));
  const pending = vm.runInContext('loadSlots()', context);
  assert.equal(nodes.get('next-button').disabled, true);
  complete(response([])); await pending;
  assert.equal(vm.runInContext('state.time', context), null);
  assert.equal(nodes.get('next-button').disabled, true);
});

test('a failed refresh clears the previous time', async () => {
  const { context, nodes } = client(async () => { throw new Error('Network unavailable'); });
  await vm.runInContext('loadSlots()', context);
  assert.equal(vm.runInContext('state.time', context), null);
  assert.equal(nodes.get('next-button').disabled, true);
});

test('a late response for a previous day cannot replace the latest available slots', async () => {
  const requests = [];
  const { context, nodes } = client(() => new Promise(resolve => { requests.push(resolve); }));
  const old = vm.runInContext('loadSlots()', context);
  vm.runInContext("state.day = '2026-10-14'; state.time = null;", context);
  const current = vm.runInContext('loadSlots()', context);
  requests[1](response([{ time: '15:00' }])); await current;
  requests[0](response([{ time: '12:00' }])); await old;
  assert.deepEqual(nodes.get('slots').children.map(node => node.textContent), ['15:00']);
});
