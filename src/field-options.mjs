import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

const xd = 'http://schemas.microsoft.com/office/infopath/2003';
const xsl = 'http://www.w3.org/1999/XSL/Transform';
const trim = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const condition = /^(?:\.\/)?(?:my:)?([\w.-]+)\s*(=|!=)\s*(["'])(.*?)\3$/u;
const allowedId = /^[\w.-]{1,128}$/u;
const choiceKinds = new Set(['DropDown', 'OptionButton', 'CheckBox', 'ListBox', 'MultiSelectListBox']);
const choiceBindings = new Set(['BoundOption', 'BoundCheck', 'BoundOptionList', 'BoundSelect', 'BoundSuggester']);
export const fieldAnalysisVersion = 1;

export function isChoiceField(field) {
  return field.apiType === 'Code' || choiceBindings.has(field.control) ||
    field.usages?.some(usage => choiceKinds.has(usage.kind)) || !!field.enumeration?.length;
}

function siblingLabel(control) {
  if (control.hasAttribute('aria-label')) return trim(control.getAttribute('aria-label'));
  const next = control.nextSibling;
  return next?.nodeType === 3 ? trim(next.nodeValue) : '';
}

function staticOptions(control, kind) {
  if (kind === 'OptionButton' || kind === 'CheckBox') {
    const label = siblingLabel(control) || trim(control.getAttribute('title'));
    const value = control.getAttributeNS(xd, 'onValue') || control.getAttribute('value');
    const off = control.getAttributeNS(xd, 'offValue');
    const options = value ? [{ value, label: label || null }] : [];
    if (kind === 'CheckBox' && off) options.push({ value: off, label: '未勾选' });
    return options;
  }
  if (control.localName !== 'select') return [];
  return Array.from(control.getElementsByTagName('*'))
    .filter(node => node.localName === 'option' && node.hasAttribute('value') && !node.hasAttribute('disabled') &&
      !/[{}]/.test(node.getAttribute('value')) && node.getAttribute('value'))
    .map(node => {
      const parents = ancestors(node);
      return { value: node.getAttribute('value'), label: trim(node.textContent) || null,
        when: conditionsOf(parents.slice(0, parents.indexOf(control))) };
    });
}

function ancestors(element) {
  const list = [];
  for (let item = element.parentNode; item?.nodeType === 1; item = item.parentNode) list.push(item);
  return list;
}

function conditionsOf(elements) {
  return elements.filter(parent => parent.namespaceURI === xsl &&
    ['if', 'when', 'otherwise'].includes(parent.localName)).map(parent => {
    const expression = parent.getAttribute('test');
    const match = condition.exec(expression?.trim() ?? '');
    return match ? { fieldId: match[1], operator: match[2], value: match[4] } : { expression: expression || 'otherwise' };
  });
}

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return;
  try { return new DOMParser().parseFromString(xml, 'application/xml'); }
  catch { return; }
}

export function extractStaticControls(xml, source) {
  const byField = new Map();
  const doc = parseXml(xml);
  if (!doc) return byField;
  for (const node of Array.from(doc.getElementsByTagName('*'))) {
    const fieldId = node.getAttributeNS(xd, 'binding')?.split('/').at(-1).split(':').at(-1);
    if (!allowedId.test(fieldId ?? '')) continue;
    const kind = node.getAttributeNS(xd, 'xctname') || (node.localName === 'select' ? 'DropDown' : '');
    const options = staticOptions(node, kind);
    const conditions = conditionsOf(ancestors(node));
    const dynamicOptions = node.localName === 'select' &&
      Array.from(node.getElementsByTagName('*')).some(child => child.namespaceURI === xsl);
    const literalOptions = !dynamicOptions && (kind === 'OptionButton' || (kind === 'CheckBox' && options.length === 2) ||
      node.localName === 'select' && !node.hasAttribute('data-source'));
    const required = node.hasAttribute('required') || node.getAttribute('aria-required') === 'true' ? true :
      node.getAttribute('aria-required') === 'false' ? false : null;
    const readOnly = node.hasAttribute('readonly') || node.hasAttribute('disabled') ||
      node.getAttribute('aria-readonly') === 'true' ? true : node.getAttribute('aria-readonly') === 'false' ? false : null;
    const selected = node.localName === 'select' ? Array.from(node.getElementsByTagName('*'))
      .filter(child => child.localName === 'option' && child.hasAttribute('selected') &&
        !conditionsOf(ancestors(child)).length).map(child => child.getAttribute('value')).filter(Boolean) : [];
    if (kind === 'OptionButton' && node.hasAttribute('checked') && options[0] && !conditions.length) {
      selected.push(options[0].value);
    }
    if (!byField.has(fieldId)) byField.set(fieldId, []);
    byField.get(fieldId).push({ kind, options, literalOptions, conditions, required, readOnly, selected, source });
  }
  return byField;
}

export async function readStaticPanels(directory, view) {
  const panels = [];
  for (const panel of view.packageViews) {
    if (!panel.file || basename(panel.file) !== panel.file) continue;
    const source = `views/${view.id}/source/${panel.file}`;
    try {
      const file = await readFile(join(directory, source), 'utf8');
      const controls = extractStaticControls(file, source);
      if (controls.size) panels.push({ source, name: panel.name, controls });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return panels;
}

export async function readTemplateDefaults(directory, viewId) {
  const source = `views/${viewId}/source/template.xml`;
  let file;
  try { file = await readFile(join(directory, source), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { values: new Map() }; throw error; }
  const doc = parseXml(file);
  const values = new Map();
  for (const node of Array.from(doc?.getElementsByTagName('*') ?? [])) {
    if (node.getElementsByTagName('*').length || !allowedId.test(node.localName)) continue;
    const value = node.textContent;
    const previous = values.get(node.localName);
    values.set(node.localName, previous === undefined || previous === value ? value : null);
  }
  return { source, values };
}

export function mergeOptions(items) {
  const byValue = new Map();
  for (const item of items) {
    const key = item.value == null ? `label:${item.label}` : `value:${item.value}`;
    const previous = byValue.get(key);
    if (!previous || (!previous.label && item.label)) byValue.set(key, item);
  }
  return [...byValue.values()];
}

function agreed(values) {
  return values.length && values.every(value => value === values[0]) ? values[0] : null;
}

function apiOptions(config) {
  if (!Array.isArray(config?.options) || !config.options.length) return [];
  const options = config.options.map(option => ({
    value: option?.codeId ?? option?.value,
    label: option?.codeName ?? option?.label,
  }));
  return options.every(option => ['string', 'number'].includes(typeof option.value) && typeof option.label === 'string')
    ? mergeOptions(options) : [];
}

export function enrichField(field, { config, definition, panels, runtime, schemaSource, template }) {
  const instances = panels.flatMap(panel => panel.controls.get(field.id) ?? []);
  const optionSets = [];
  const dependencies = [];
  const panelStates = [];
  for (const panel of panels) {
    const controls = panel.controls.get(field.id);
    if (!controls?.length) continue;
    const required = agreed(controls.map(control => control.required));
    const readOnly = agreed(controls.map(control => control.readOnly));
    if (required !== null || readOnly !== null) panelStates.push({ panel: panel.name, required, readOnly, source: panel.source });
    const groups = new Map();
    for (const control of controls) {
      const key = JSON.stringify(control.conditions);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(control);
    }
    for (const set of groups.values()) {
      const when = set[0].conditions;
      const options = mergeOptions(set.flatMap(control => control.options.filter(option => !option.when?.length)
        .map(({ value, label }) => ({ value, label }))));
      if (options.length) optionSets.push({
        panel: panel.name, when, options, source: panel.source, kind: 'xsn',
        completeness: !when.length && set.every(control => control.literalOptions && control.options.length) ? 'complete' : 'partial',
      });
      const conditional = new Map();
      for (const option of set.flatMap(control => control.options).filter(option => option.when?.length)) {
        const key = JSON.stringify(option.when);
        if (!conditional.has(key)) conditional.set(key, { when: [...when, ...option.when], options: [] });
        conditional.get(key).options.push({ value: option.value, label: option.label });
      }
      for (const variant of conditional.values()) optionSets.push({
        panel: panel.name, ...variant, options: mergeOptions(variant.options), source: panel.source,
        kind: 'xsn', completeness: 'partial',
      });
    }
    if (controls.every(control => control.conditions.length)) {
      dependencies.push({ kind: 'template-visibility', alternatives: [...groups.values()].map(set => set[0].conditions),
        panel: panel.name, source: panel.source });
    }
  }
  if (field.enumeration?.length) optionSets.push({
    when: [], options: field.enumeration.map(value => ({ value, label: null })),
    source: schemaSource, kind: 'schema', completeness: 'complete',
  });
  const defined = apiOptions(definition);
  if (defined.length) optionSets.push({
    when: [], options: defined, source: field.evidence, kind: 'form-definition', completeness: 'complete',
  });
  if (config?.label && field.name === field.id) field.name = config.label;
  if (field.name === field.id) {
    const liveLabel = runtime.find(item => item.versionVerified && typeof item.fieldName === 'string' && item.fieldName)?.fieldName;
    if (liveLabel) field.name = liveLabel;
  }
  field.control = config?.control || undefined;
  field.required = typeof definition?.required === 'boolean' ? definition.required :
    config?.required ?? agreed(instances.map(control => control.required));
  field.readOnly = typeof definition?.readOnly === 'boolean' ? definition.readOnly :
    config?.control === 'BoundLabel' ? true : agreed(instances.map(control => control.readOnly));
  if (config) field.fieldConfigSource = config.source;
  field.defaultSource = field.defaultValue != null ? schemaSource : undefined;
  const templateValue = template?.values.get(field.id);
  if (typeof templateValue === 'string') {
    field.defaultValue = templateValue;
    field.defaultSource = template.source;
  }
  const defaults = [...new Set(instances.flatMap(control => control.selected))];
  if (['string', 'number', 'boolean'].includes(typeof definition?.defaultValue)) {
    field.defaultValue = definition.defaultValue;
    field.defaultSource = field.evidence;
  }
  if (field.defaultValue == null && defaults.length === 1) {
    field.defaultValue = defaults[0];
    field.defaultSource = instances.find(control => control.selected.length)?.source;
  }
  if (panelStates.length) field.panelStates = panelStates;
  for (const item of runtime) {
    if (item.options?.length) optionSets.push({
      options: item.options, when: item.when, source: item.source, kind: item.kind,
      completeness: item.completeness, request: item.request, viewScoped: !!item.viewId,
      versionVerified: item.versionVerified,
    });
    if (item.state) {
      field.observedStates ??= [];
      field.observedStates.push({ when: item.when, ...item.state, source: item.source, versionVerified: item.versionVerified });
    }
    if (item.changes?.length) dependencies.push({ kind: 'observed-change', when: item.when, changes: item.changes,
      source: item.source, versionVerified: item.versionVerified });
  }
  if (dependencies.length) field.dependencies = dependencies;
  if (isChoiceField(field) || optionSets.length) {
    field.optionSets = optionSets;
    field.optionStatus = optionSets.some(item => item.completeness === 'complete' &&
      item.options.every(option => option.label && option.value != null))
      ? 'known' : optionSets.length ? 'partial' : 'unavailable';
  }
  return field;
}
