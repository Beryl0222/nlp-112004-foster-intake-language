import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle, readCollection } from '../tools/materials.mjs';

test('接件资料包含原文和原始记录', () => {
  const bundle = readBundle();
  const excerpts = [["messages", "m4", "白背躲在车后"], ["messages", "m6", "CH-801"], ["messages", "m7", "CH-913"], ["handoffs", "h1", "按一只记"], ["handoffs", "h3", "之后由原主确认"]];
  for (const [group, id, phrase] of excerpts) {
    const entry = bundle[group].find(row => row.id === id);
    assert.ok(entry, `${group}/${id} 缺少来件`);
    if (phrase) assert.ok(Object.values(entry).some(value => typeof value === 'string' && value.includes(phrase)), `${group}/${id} 的源文字缺少约定片段`);
  }
});

test('拒绝缺少正式字段的接件', t => {
  const directory = mkdtempSync(join(tmpdir(), 'foster-intake-language-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'animals.json'), JSON.stringify([{ id: 'bad' }]));
  assert.throws(() => readCollection('animals', pathToFileURL(directory + sep)), TypeError);
});

test('登记档案保留重名与独立芯片号，预约保留当时使用的编号', () => {
  const { animals, handoffs } = readBundle();
  const chips = animals.map(row => row.chip).filter(chip => chip !== null);
  assert.equal(new Set(chips).size, chips.length);
  assert.ok(animals.filter(row => row.name === '糖糖').length > 1);
  assert.ok(handoffs.every(row => row.mayInclude.includes(row.assigned)));
});
