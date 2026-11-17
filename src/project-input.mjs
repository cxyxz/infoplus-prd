import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { officialDirectory } from './output-management.mjs';

export function projectQuery(input) {
  const query=input.trim();
  return query.match(/^([A-Z]\d+)\s*(?:[:：]|$)/i)?.[1].toUpperCase() || query;
}

export async function findCachedProject(query, version=process.env.INFOPLUS_VERSION) {
  const output=dirname(officialDirectory('_'));
  const dirs=await readdir(output,{withFileTypes:true}).catch(error=>{
    if(error.code==='ENOENT')return [];
    throw error;
  });
  const matches=[];
  for(const dir of dirs.filter(dir=>dir.isDirectory()&&/^[A-Z]\d+$/i.test(dir.name))){
    if(/^[A-Z]\d+$/i.test(query)&&dir.name.toUpperCase()!==query.toUpperCase())continue;
    const root=join(output,dir.name);
    const candidates=[root];
    const entries=await readdir(root,{withFileTypes:true});
    for(const entry of entries)if(entry.isDirectory()&&/^\d{8}-\d{6}$/.test(entry.name))candidates.push(join(root,entry.name));
    for(const candidate of candidates){
      const metadata=await readFile(join(candidate,'project.json'),'utf8').then(JSON.parse,error=>{
        if(error.code!=='ENOENT')throw error;
      });
      if(!metadata)continue;
      if((!version||metadata.version===version) && [metadata.code,metadata.name,metadata.projectCode]
        .some(value=>String(value??'').toLowerCase()===query.toLowerCase()))matches.push(candidate);
      // The canonical project file is authoritative even when another version is requested.
      if(candidate===root)break;
    }
  }
  if(matches.length>1)throw new Error('缓存有多个匹配项目或版本，请使用编号并核对 INFOPLUS_VERSION');
  return matches[0];
}
