import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { json } from './analyze.mjs';
import { withRenderer } from './render.mjs';
import { importTemplateJson, importXsn } from './xsn.mjs';

export async function importTemplates(sourceDirectory, versionDirectory) {
  const project = await json(join(versionDirectory, 'project.json'));
  const names = new Set((await readdir(sourceDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => entry.name.toLowerCase()));
  const raw = join(versionDirectory, 'raw', 'templates');
  await mkdir(raw, { recursive: true });
  const result = { imported: [], unmatched: [], failed: [] };
  await withRenderer(async render => {
    for (const view of project.views) {
      if (!/^[a-f0-9-]{36}$/i.test(view.id)) throw new Error('视图 ID 格式错误');
      const keys = [view.id, view.name].filter(key => /^[^\\/:*?"<>|]+$/.test(key));
      const file = ['xsn', 'json'].flatMap(ext => keys.map(key => `${key}.${ext}`))
        .find(name => names.has(name.toLowerCase()));
      if (!file) {
        result.unmatched.push(view.name);
        continue;
      }
      const xsn = file.endsWith('.xsn');
      const saved = join(raw, `${view.id}.${xsn ? 'xsn' : 'json'}`);
      try {
        await copyFile(join(sourceDirectory, file), saved, constants.COPYFILE_EXCL).catch(error => {
          if (error.code !== 'EEXIST') throw error;
        });
        const importer = xsn ? importXsn : importTemplateJson;
        await importer(saved, join(versionDirectory, 'views', view.id), render);
        result.imported.push(view.name);
      } catch {
        result.failed.push(view.name);
      }
    }
  });
  return result;
}
