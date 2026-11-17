import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeSectionImages, dedupeSectionRules, imageCropSegments } from '../src/image-layout.mjs';

const page = { width: 11906, height: 16838, top: 1134, bottom: 1134, left: 1418, right: 1418 };

test('超长附录图片按可用页面高度分段，并保留完整纵向范围', () => {
  const segments = imageCropSegments({ width: 1440, height: 5219 }, page, 130);
  assert.ok(segments.length > 1);
  assert.equal(segments[0].crop.top, 0);
  assert.equal(segments.at(-1).crop.bottom, 0);
  for (let index = 1; index < segments.length; index++) {
    assert.ok(Math.abs(
      100 - segments[index - 1].crop.bottom - segments[index].crop.top,
    ) < 1e-9);
  }
  const availableHeight = (page.height - page.top - page.bottom) / 15 - 130;
  assert.ok(segments.every(segment => segment.height <= availableHeight));
});

test('普通页面图片保持单图，不生成伪分段', () => {
  const segments = imageCropSegments({ width: 1440, height: 1000 }, page, 130);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].crop, undefined);
});

test('跨节点相同的业务模块图只保留首次放置，节点内容仍保留', () => {
  const same = Buffer.from('same-image');
  const other = Buffer.from('other-image');
  const sections = [
    { name: 'A', screenshots: [{ title: '共同模块', image: { data: same } }] },
    { name: 'B', screenshots: [
      { title: '共同模块', image: { data: same } },
      { title: '专属按钮', image: { data: other } },
    ] },
  ];
  dedupeSectionImages(sections, value => value.toString('hex'));
  assert.deepEqual(sections.map(section => section.screenshots.map(image => image.title)), [
    ['共同模块'],
    ['专属按钮'],
  ]);
  assert.equal(sections[1].name, 'B');
});

test('跨节点相同业务规则只保留首次说明，节点专有规则仍保留', () => {
  const sections = [
    { rules: ['单位：只读', '节点甲：允许退回申请人'] },
    { rules: ['单位：只读', '节点乙：允许提交国合处审核'] },
  ];
  dedupeSectionRules(sections);
  assert.deepEqual(sections.map(section => section.rules), [
    ['单位：只读', '节点甲：允许退回申请人'],
    ['节点乙：允许提交国合处审核'],
  ]);
});
