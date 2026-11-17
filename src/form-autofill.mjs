/**
 * InfoPlus PRD Skill V1.2 — 通用表单必填扫描 / 自动填报 / 校验修复 / 节点采集
 *
 * 设计原则：
 *  - 不硬编码任何流程编号、字段名或审批节点；所有策略通过 options 注入。
 *  - 必填信息以真实 DOM 为准（InfoPlus 的 entity.fields 通常不带 required 标记，
 *    校验由控件的 validate[...] 类与 .formError 驱动），因此必须扫描整个文档而非可视区域。
 *  - 覆盖：可见/滚动区外/条件隐藏字段、单选、复选、下拉、日期、文本、成员/组织、
 *    附件、子表格，以及因联动新出现的动态必填项。
 */
import fs from 'node:fs';
import path from 'node:path';

import { version } from './version.mjs';
export const FORM_AUTOFILL_VERSION = version;

export const DEFAULT_TEST_VALUES = {
  phone: '',
  email: 'infoplus-debug@example.invalid',
  date: '2026-11-16',
  dateFrom: '2026-11-16',
  dateTo: '2026-11-20',
  number: '1',
  text: '【InfoPlus DEBUG 测试数据】仅用于后台调试验证流程流转，不代表真实业务内容。',
  opinion: '【InfoPlus DEBUG 测试意见】同意，仅用于后台调试验证，不代表真实审批意见。',
  member: '', // 成员/组织字段交由专门的 chooseDebugMember 处理
};

/** 依据字段名与标签推断合规测试值（通用，不含流程专属逻辑） */
export function testValueFor(name = '', label = '', options = {}) {
  const values = { ...DEFAULT_TEST_VALUES, ...(options.testValues || {}) };
  const s = `${name} ${label}`.toLowerCase();
  if (options.valueOverrides?.[name]) return options.valueOverrides[name];
  if (/phone|mobile|tel|手机|联系电话|电话/.test(s)) return values.phone;
  if (/email|mail|邮箱|邮件/.test(s)) return values.email;
  if (/opinion|advice|comment|意见|备注|说明|建议/.test(s)) return values.opinion;
  if (/datefrom|startdate|sjfrom|起始|开始日期|离境/.test(s)) return values.dateFrom;
  if (/dateto|enddate|sjto|结束|截止|入境/.test(s)) return values.dateTo;
  if (/date|日期|时间/.test(s)) return values.date;
  if (/number|amount|count|数量|人数|金额/.test(s)) return values.number;
  return values.text;
}

/** 全页面表单状态扫描（含隐藏/滚动区外控件） */
export async function scanFormState(page) {
  return page.evaluate(() => {
    const e = window.$$?.entity;
    const data = e?.data || {};
    const fields = e?.fields || {};
    const labelNear = el => {
      if (!el) return '';
      const td = el.closest('td');
      if (td) {
        let prev = td.previousElementSibling;
        for (let i = 0; i < 3 && prev; i++) {
          const t = prev.innerText.replace(/\s+/g, ' ').trim();
          if (t) return t.slice(0, 160);
          prev = prev.previousElementSibling;
        }
      }
      return (el.closest('tr')?.innerText || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    };
    const visible = el => !!el?.getClientRects().length;

    const errors = [...document.querySelectorAll('.formError')]
      .filter(x => x.innerText.trim())
      .map(x => {
        const key = (x.className.match(/^([\w-]+)formError/) || [])[1] || '';
        const el = key ? document.getElementById(key) : null;
        const m = key.match(/^(field\w+)-\d+$/);
        const groupName = m ? `radioList-${m[1]}` : null;
        const kind = key.startsWith('file_') ? 'attachment'
          : (m ? 'radio' : (/active_input/.test((el?.className || '').toString()) ? 'member'
            : (el?.tagName === 'SELECT' ? 'select' : 'text')));
        // V1.2：InfoPlus 的红色提示不会在补填后即时清除，必须按控件真实状态判定是否已满足，
        // 否则会把「残留 DOM 提示」误当未修复，造成重复点击与错误的阻断归因。
        let satisfied = false;
        if (kind === 'radio') satisfied = !!document.querySelector(`input[type=radio][name="${groupName}"]:checked`);
        else if (kind === 'attachment') {
          const box = document.getElementById(key);
          const name = box?.querySelector('.uploadFileName')?.innerText.replace(/\s+/g, '').trim();
          const ok = box?.querySelector('.uploadSuccess');
          satisfied = !!name || !!(ok && getComputedStyle(ok).display !== 'none');
         } else {
          const value = String(el?.value ?? '').trim();
          const msg = x.innerText;
          satisfied = !!value;
          if (/格式|正确|无效|invalid/i.test(msg)) {
            satisfied = false;
            if (/电话|联系|手机/.test(msg + labelNear(el))) satisfied = /^1[3-9]\d{9}$/.test(value) || /^0\d{2,3}-?\d{7,8}$/.test(value);
            else if (/邮箱|邮件/.test(msg + labelNear(el))) satisfied = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
            else if (el?.pattern || el?.type === 'date') satisfied = !!value && el.checkValidity();
          }
          if (el?.validity && !el.validity.valid) satisfied = false;
        }
        return {
          key, msg: x.innerText.replace(/\s+/g, ' ').trim(), visible: visible(x), kind, satisfied,
          controlName: el?.name || '', controlTag: el?.tagName || '', groupName,
          label: labelNear(el), value: el?.value ?? null,
        };
      });

    const controls = [...document.querySelectorAll('input,select,textarea')].map(x => ({
      tag: x.tagName, id: x.id, name: x.name, type: x.type, value: x.value,
      checked: x.checked, cls: (x.className || '').toString().slice(0, 140),
      visible: visible(x), label: labelNear(x), writable: /infoplus_editControl|infoplus_writable/.test(x.className || ''),
    }));

    const radioGroups = {};
    for (const x of document.querySelectorAll('input[type=radio],input[type=checkbox]')) {
      const k = x.name || x.id.replace(/-\d+$/, '');
      (radioGroups[k] ||= { name: k, type: x.type, options: [] }).options.push({
        id: x.id, value: x.value, checked: x.checked, visible: visible(x),
        text: (document.querySelector(`label[for="${x.id}"]`)?.innerText || x.parentElement?.innerText || '')
          .replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    }

    const fileControls = [...document.querySelectorAll('div.infoplus_fileControl')].map(x => ({
      id: x.id, visible: visible(x), hasFileInput: !!x.querySelector('input[type=file]'),
      label: labelNear(x), text: x.innerText.replace(/\s+/g, ' ').trim().slice(0, 160),
    }));

    // 真实命令栏按钮：a[name^="infoplus_action_"]，包含不在 entity.actions 中的平台级按钮（如「终止」）
    const commandButtons = [...document.querySelectorAll('a[name^="infoplus_action_"]')].map(x => ({
      id: x.id, name: x.getAttribute('name'),
      actionId: (x.getAttribute('name').match(/_(\w+)$/) || [])[1],
      text: (x.innerText || '').replace(/\s+/g, ' ').trim(),
      tip: (x.querySelector('.toolbar_button_tip')?.innerText || '').trim(),
      kill: /kill/.test(x.className || ''), visible: visible(x),
      html: x.outerHTML.slice(0, 400),
    }));

    const entityActions = (e?.actions || []).map(a => ({ id: a.id, name: a.name, visible: a.visible }));

    const fieldList = Object.entries(fields).map(([id, f]) => ({
      id, label: f?.label || '', type: f?.type || '', permission: f?.permission || '',
      value: typeof data[id] === 'object' ? JSON.stringify(data[id]).slice(0, 200) : (data[id] ?? ''),
      optionCount: (f?.options || []).length,
    }));

    const dialogs = [...document.querySelectorAll('.dialog.display')]
      .filter(visible)
      .map(x => ({ id: x.id, text: x.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) }));

    return {
      url: location.href,
      capturedAt: new Date().toISOString(),
      step: e?.step ? {
        instanceId: e.step.instanceId, stepId: e.step.stepId, name: e.step.name,
        status: e.step.status, flowStepId: e.step.flowStepId, release: e.step.release,
      } : null,
      identity: { userId: e?.userId, actionAccount: data?._VAR_ACTION_ACCOUNT, ownerPhone: data?._VAR_OWNER_PHONE, ownerEmail: data?._VAR_OWNER_EMAIL },
      errors, controls, radioGroups, fileControls, commandButtons, entityActions,
      fields: fieldList, fieldCount: fieldList.length, dialogs,
      formTitle: document.title,
    };
  });
}

import { classifyDialog } from './dialog-classification.mjs';
export const INFORMATIONAL_DIALOG = /打印提示|调试说明|仅供调试|如有其它相关说明，请点击备注/;
// Acknowledgement never implies successful validation. Leave unknown/submission dialogs open.
export async function dismissDialogs(page) {
 const closed = [];
 for (const dialog of (await page.locator('.dialog.display').all()).reverse()) {
  const text = await dialog.innerText();
  const classification = classifyDialog(text);
  if (!['information','required-validation','format-validation','business-validation','external-service'].includes(classification)) continue;
  for (const button of await dialog.locator('button,a,input[type=button]').all()) {
   const label = (await button.innerText().catch(()=>'') || await button.getAttribute('value') || '').trim();
   if (/^(确定|确认|好|知道了|OK|关闭)$/i.test(label)) {
    closed.push({ text, classification, acknowledged: true, validationPassed: false });
    await button.click(); break;
   }
  }
 }
 return closed;
}

/** 单轮修复：处理当前所有可见校验错误 */
export async function repairPass(page, state, options = {}) {
  const opts = {
    radioPreference: 'negative', // negative=选「否」；first=首个；last=末个
    testAttachment: null,
    ...options,
  };
  const fixed = [];
  const skipped = [];
  await dismissDialogs(page);
  const active = (state?.errors || []).filter(e => e.visible && e.msg && !e.satisfied);

  for (const err of active) {
    const key = err.key;
    if (!key) { skipped.push({ reason: 'no-control-key', msg: err.msg }); continue; }

    if (err.kind === 'attachment') {
      if (!opts.testAttachment || !fs.existsSync(opts.testAttachment)) {
        skipped.push({ key, reason: 'test-attachment-unavailable', label: err.label }); continue;
      }
      const input = page.locator(`[id="${key}"] input[type=file]`);
      if (await input.count() === 0) { skipped.push({ key, reason: 'file-input-not-found', label: err.label }); continue; }
      try {
        await input.setInputFiles(opts.testAttachment);
        await page.waitForTimeout(1800);
        const status = await page.evaluate(k => {
          const box = document.getElementById(k);
          return { text: box?.innerText.replace(/\s+/g, ' ').trim().slice(0, 160),
            success: !!box?.querySelector('.uploadSuccess') && getComputedStyle(box.querySelector('.uploadSuccess')).display !== 'none',
            link: box?.querySelector('.infoplus_fileControl_link')?.getAttribute('href') || '' };
        }, key);
        fixed.push({ key, action: 'upload', label: err.label, file: path.basename(opts.testAttachment), status });
      } catch (error) {
        skipped.push({ key, reason: 'upload-failed', error: error.message.slice(0, 160) });
      }
      continue;
    }

    // V1.2：成员/组织选择控件（input.active_input）必须走平台自动补全候选：
    // 聚焦 → suggestDiv 展示真实候选 → 键盘 Enter 选择首个可选身份（授权 DEBUG 角色模拟，不导出人员名单）。
    if (err.kind === 'member') {
      try {
        await page.locator(`[id="${key}"]`).focus();
        await page.waitForTimeout(900);
        const opened = await page.evaluate(k => {
          const base = k.replace(/_activeInput$/, '');
          const sug = document.getElementById(`${base}_suggestDiv`);
          const items = sug ? [...sug.querySelectorAll('.infoplus_suggester_item')] : [];
          return { visible: !!sug && getComputedStyle(sug).display !== 'none', count: items.length,
            first: items[0]?.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) || '' };
        }, key);
        if (!opened.visible || !opened.count) {
          skipped.push({ key, action: 'member', label: err.label, reason: 'suggestion-list-unavailable' }); continue;
        }
        await page.keyboard.press('Enter');
        await page.waitForTimeout(700);
        const value = await page.evaluate(k => document.getElementById(k)?.value || '', key);
        (value ? fixed : skipped).push({ key, action: 'member', label: err.label,
          selected: value, candidateCount: opened.count, firstCandidate: opened.first,
          ok: !!value });
      } catch (error) {
        skipped.push({ key, action: 'member', label: err.label, error: error.message.slice(0, 140) });
      }
      continue;
    }

    if (err.kind === 'radio') {
      const r = await page.evaluate(({ groupName, pref }) => {
        const radios = [...document.querySelectorAll(`input[type=radio][name="${groupName}"]`)];
        if (!radios.length) return { ok: false, reason: 'group-not-found' };
        const labelOf = x => (document.querySelector(`label[for="${x.id}"]`)?.innerText || x.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
        let target = radios.find(x => /否|No\b|N\)|无|未/i.test(labelOf(x)));
        if (pref === 'first') target = radios[0];
        if (pref === 'last') target = radios[radios.length - 1];
        if (!target) target = radios[radios.length - 1];
        target.click();
        try { window.jQuery?.(target).prop('checked', true).trigger('change'); } catch (_) {}
        return { ok: true, id: target.id, value: target.value, text: labelOf(target).slice(0, 60) };
      }, { groupName: err.groupName, pref: opts.radioPreference });
      (r.ok ? fixed : skipped).push({ key, action: 'radio', label: err.label, ...r });
      continue;
    }

    // 文本 / 下拉 / 日期 / 成员等普通控件
    const value = testValueFor(err.controlName, err.label, opts);
    if (!value) { skipped.push({key, reason:'requires-authorized-test-value'}); continue; }
    const r = await page.evaluate(({ key, value }) => {
      const el = document.getElementById(key);
      if (!el) return { ok: false, reason: 'control-not-found' };
      if (el.tagName === 'SELECT') {
        const opts = [...el.options].filter(o => o.value && !/请选择|select/i.test(o.text));
        if (!opts.length) return { ok: false, reason: 'no-selectable-option' };
        el.value = opts[0].value;
        try { window.jQuery?.(el).val(opts[0].value).trigger('change'); } catch (_) {}
        return { ok: true, name: el.name, value: el.value, optionText: opts[0].text.slice(0, 60) };
      }
      try { window.jQuery?.(el).val(value).trigger('input').trigger('change').trigger('blur'); }
      catch (_) {}
      if (!window.jQuery) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      return { ok: true, name: el.name, value: el.value };
    }, { key, value });
    (r.ok ? fixed : skipped).push({ key, action: err.kind, label: err.label, ...r });
  }

  // 等待条件联动渲染（动态字段可能新增必填）
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => !window.jQuery?.active, undefined, { timeout: 6000 }); } catch (_) {}
  const after = await scanFormState(page);
  return { fixed, skipped, before: state?.errors?.length || 0, after };
}

/**
 * V1.2：从服务端业务校验（errno≠0 的 error 文本，如「请确认已完成回访！」）推断需要补填的字段。
 * 这类校验不产生 DOM formError，只通过提交响应返回，因此必须单独识别，避免重复无效提交。
 * 返回需补填的单选/勾选项列表（通用匹配：把提示文本关键字与单选 label 做包含匹配）。
 */
export async function inferServerValidationFields(page, errorText) {
  if (!errorText) return [];
  return page.evaluate(errText => {
    const key = String(errText).replace(/[！!。.,，请确认请已完成\s]/g, '').trim();
    const out = [];
    // 在全部 radio 组中找 label 与提示文本高度重合的项，选「是/已/完成」语义的首项
    const groups = {};
    for (const r of document.querySelectorAll('input[type=radio][name^=radioList-]')) {
      (groups[r.name] ||= []).push(r);
    }
    for (const [name, radios] of Object.entries(groups)) {
      const labels = radios.map(r => (document.querySelector(`label[for="${r.id}"]`)?.innerText || r.parentElement?.innerText || '').replace(/\s+/g, ' '));
      const joined = labels.join(' ');
      if (key && joined.replace(/[！!。.,，*\s]/g, '').includes(key.slice(0, 4))) {
        const target = radios.find((r, i) => /是|已|完成|Y/i.test(labels[i])) || radios[0];
        if (target && !target.checked) {
          out.push({ group: name, candidateValue: target.value, label: labels[radios.indexOf(target)], requiresBusinessEvidence: true });
        }
      }
    }
    return out;
  }, errorText);
}

/** 错误指纹：用于识别「连续重复同一无法解决的错误」 */
export function errorFingerprint(errors = []) {
  return errors.filter(e => e.visible && e.msg && !e.satisfied)
    .map(e => `${e.key}::${e.msg.replace(/\s+/g, '')}`).sort().join('|');
}

/** 节点级证据采集：字段全量 + 按钮 + 整页真实截图 */
export async function captureNodeBundle(page, directory, slug, options = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const state = await scanFormState(page);
  const jsonPath = path.join(directory, `${slug}-node.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2), 'utf-8');
  let screenshot = null;
  try {
    screenshot = path.join(directory, `${slug}-full.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled', timeout: 30000 });
  } catch (error) { screenshot = `FAILED: ${error.message.slice(0, 120)}`; }
  const summary = {
    slug, capturedAt: state.capturedAt, url: state.url, step: state.step, identity: state.identity,
    fieldCount: state.fieldCount, controlCount: state.controls.length,
    commandButtons: state.commandButtons.map(b => ({ text: b.text, actionId: b.actionId, kill: b.kill, tip: b.tip })),
    entityActions: state.entityActions, visibleErrors: state.errors.filter(e => e.visible).length,
    fileControls: state.fileControls.filter(f => f.visible).length,
    jsonPath, screenshot,
  };
  fs.writeFileSync(path.join(directory, `${slug}-summary.json`), JSON.stringify(summary, null, 2), 'utf-8');
  return { state, summary };
}
