import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile, cp, rename, stat, realpath } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import extract from 'extract-zip'
import { extract as extractTar } from 'tar'

export interface ShellSkinEntry { id:string; name:{zh:string;en:string}; author:string; description:string; repo:string; subpath?:string; package:string; install:{version:string;commit:string}; license?:{code:string;commercialUse:boolean;notice?:string}; screenshots?:string[] }
export interface ShellSkinProgress { skinId:string; phase:'prepare'|'download'|'validate'|'copy'|'complete'|'failed'; message:string; detail?:string; elapsedMs:number }
export interface ShellSkinState { activeSkinId:string|null; installed:Record<string,{version:string;directory:string;clientPath:string;compatible:boolean;installedAt?:number;error?:string}> }

type ClientManifest = { name?:string; version?:string; exports?: Record<string, unknown>; dsh?: { client?: unknown } }
type NpmPackageMetadata = { name?:unknown; version?:unknown; gitHead?:unknown; dist?:{tarball?:unknown;integrity?:unknown} }
async function readClientManifest(source:string):Promise<ClientManifest>{return JSON.parse((await readFile(join(source,'package.json'),'utf8')).replace(/^\uFEFF/,'')) as ClientManifest}
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['browser', 'import', 'default', 'require', 'node']) {
    const target = exportTarget(record[key])
    if (target !== undefined) return target
  }
  return undefined
}
export async function resolveClientEntry(manifest: ClientManifest, source: string): Promise<string> {
  const declared = exportTarget(manifest.exports?.['./client'])
  const candidates = [
    declared,
    './lib/plugin/dist/client.js',
    './lib/client.js',
    './plugin/dist/client.js',
    './plugin/client.js',
    './dist/client.js',
    './client.js',
  ].filter((value): value is string => typeof value === 'string')
  for (const candidate of candidates) {
    if (candidate.startsWith('/') || candidate.includes('..')) continue
    const target = resolve(source, candidate)
    if (!target.startsWith(resolve(source) + sep)) continue
    try { await access(target); return candidate } catch { /* try the next reviewed package-local convention */ }
  }
  throw new Error('未找到可注入的客户端入口（支持 exports["./client"] 条件导出及 lib/plugin/dist/client.js）')
}
async function downloadPinnedNpmPackage(skin:Pick<ShellSkinEntry,'package'|'install'>,target:string,fetcher:typeof fetch):Promise<void>{
  const metadataUrl='https://registry.npmjs.org/'+encodeURIComponent(skin.package)+'/'+encodeURIComponent(skin.install.version)
  const metadataResponse=await fetcher(metadataUrl,{signal:AbortSignal.timeout(15000)})
  if(!metadataResponse.ok)throw new Error('npm 构建包元数据请求失败: HTTP '+metadataResponse.status)
  const metadata=await metadataResponse.json() as NpmPackageMetadata
  if(metadata.name!==skin.package||metadata.version!==skin.install.version||metadata.gitHead!==skin.install.commit)throw new Error('npm 构建包与市场锁定的 package/version/commit 不一致')
  if(typeof metadata.dist?.tarball!=='string'||typeof metadata.dist.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist.integrity))throw new Error('npm 构建包缺少可验证的 sha512 信息')
  const tarballUrl=new URL(metadata.dist.tarball)
  if(tarballUrl.protocol!=='https:'||tarballUrl.hostname!=='registry.npmjs.org')throw new Error('npm 构建包下载地址无效')
  const tarballResponse=await fetcher(tarballUrl,{signal:AbortSignal.timeout(180000)})
  if(!tarballResponse.ok)throw new Error('npm 构建包下载失败: HTTP '+tarballResponse.status)
  const finalUrl=tarballResponse.url?new URL(tarballResponse.url):tarballUrl
  if(finalUrl.protocol!=='https:'||finalUrl.hostname!=='registry.npmjs.org')throw new Error('npm 构建包重定向地址无效')
  const body=Buffer.from(await tarballResponse.arrayBuffer())
  const expected=Buffer.from(metadata.dist.integrity.slice('sha512-'.length),'base64')
  const actual=createHash('sha512').update(body).digest()
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('npm 构建包 sha512 校验失败')
  const archive=target+'.npm.tgz';const expanded=target+'.npm'
  await rm(archive,{force:true});await rm(expanded,{recursive:true,force:true});await writeFile(archive,body);await mkdir(expanded,{recursive:true})
  try{
    await extractTar({file:archive,cwd:expanded,strip:1,strict:true,preservePaths:false,filter:(path,entry)=>(path==='package'||path.startsWith('package/'))&&('type' in entry?(entry.type==='Directory'||entry.type==='File'):(entry.isDirectory()||entry.isFile()))})
    const manifest=await readClientManifest(expanded)
    if(manifest.name!==skin.package||manifest.version!==skin.install.version)throw new Error('npm 构建包内部清单不一致')
    await rm(target,{recursive:true,force:true});await rename(expanded,target)
  }finally{await rm(archive,{force:true});await rm(expanded,{recursive:true,force:true})}
}
export async function resolveClientPackage(skin:Pick<ShellSkinEntry,'package'|'install'>,source:string,onOutput:(text:string)=>void=()=>{},fetcher:typeof fetch=fetch):Promise<string>{
  let manifest=await readClientManifest(source)
  if(manifest.name!==skin.package||manifest.dsh?.client===undefined)throw new Error('皮肤客户端清单不兼容')
  try{return await resolveClientEntry(manifest,source)}catch(sourceError){
    onOutput('固定 commit 源码中没有客户端 bundle，正在读取同 commit 的 npm 构建包')
    try{await downloadPinnedNpmPackage(skin,source,fetcher)}catch(npmError){throw new Error((sourceError instanceof Error?sourceError.message:String(sourceError))+'；npm 构建包回退失败：'+(npmError instanceof Error?npmError.message:String(npmError)))}
    manifest=await readClientManifest(source)
    if(manifest.name!==skin.package||manifest.version!==skin.install.version||manifest.dsh?.client===undefined)throw new Error('npm 构建包客户端清单不兼容')
    return resolveClientEntry(manifest,source)
  }
}
export function isInjectableClientBundle(bundle: string): boolean {
  const normalized = bundle.replace(/^\uFEFF/, '')
  return /window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(\s*\{/.test(normalized)
}
export function clientCompatibilityError(_bundle: string): string | undefined { return undefined }
const CATALOG_URL='https://raw.githubusercontent.com/kingOfSoySauce/dsh-skin-market/main/data/catalog.json'
const PREVIEW_HOSTS=new Set(['raw.githubusercontent.com','kingofsoysauce.github.io'])
const PREVIEW_TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif'])
const MAX_PREVIEW_BYTES=12*1024*1024
const MAX_PREVIEW_CACHE_BYTES=48*1024*1024

const ASSET_TYPES:Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.avif':'image/avif','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'}
const NATIVE_TYPES:Record<string,string>={...ASSET_TYPES,'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}

/** Resolve only reviewed, package-local shell assets. */
export async function resolveShellSkinAsset(directory:string, requestPath:string):Promise<{body:Buffer;contentType:string}> {
  const raw=requestPath.replace(/^\/+/, '')
  const segments=raw.split(/[\\/]+/)
  if (!raw || segments.some(segment=>!segment || segment==='..' || segment==='.' || segment.startsWith('.'))) throw new Error('皮肤资源路径越界')
  const relative=segments.join('/')
  const routeRelative=segments.length>1?segments.slice(1).join('/'):undefined
  const packageRoot=resolve(directory)
  const candidates:[string,string,Record<string,string>][]=[
    [resolve(packageRoot,'native-dist'),relative,NATIVE_TYPES],
    [packageRoot,relative,ASSET_TYPES],
    [resolve(packageRoot,'assets'),relative,ASSET_TYPES],
  ]
  if (routeRelative!==undefined) {
    candidates.push([resolve(packageRoot,'assets'),routeRelative,ASSET_TYPES])
    candidates.push([resolve(packageRoot,'native-dist'),routeRelative,NATIVE_TYPES])
  }
  for (const [root, rel, types] of candidates) {
    const extension=extname(rel).toLowerCase()
    if (!(extension in types)) continue
    const rootReal=await realpathIfExists(root)
    if (rootReal===undefined) continue
    const target=resolve(root,rel)
    if (target!==root && !target.startsWith(root+sep)) continue
    const targetReal=await realpathIfExists(target)
    if (targetReal===undefined || (targetReal!==rootReal && !targetReal.startsWith(rootReal+sep))) continue
    try { if (!(await stat(targetReal)).isFile()) continue } catch { continue }
    return {body:await readFile(targetReal),contentType:types[extension]!}
  }
  throw new Error('未找到皮肤资源')
}
async function realpathIfExists(path:string):Promise<string|undefined>{try{return await realpath(path)}catch{return undefined}}

function safeId(id:string):string { if(!/^[a-z0-9][a-z0-9._-]{1,180}$/i.test(id)) throw new Error('皮肤 ID 非法'); return id }
async function run(command:string,args:string[],cwd:string|undefined,onOutput:(text:string)=>void,timeoutMs=180000):Promise<void>{ await new Promise<void>((ok,fail)=>{ const child=spawn(command,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false}); let tail=''; const accept=(chunk:unknown)=>{const text=String(chunk);tail=(tail+text).slice(-8000);for(const line of text.split(/\r?\n/))if(line.trim())onOutput(line.trim())}; child.stdout.on('data',accept);child.stderr.on('data',accept);const timer=setTimeout(()=>{child.kill();fail(new Error(command+' 超时，最后输出：'+tail.slice(-1200)))},timeoutMs);child.once('error',error=>{clearTimeout(timer);fail(error)});child.once('close',code=>{clearTimeout(timer);code===0?ok():fail(new Error(command+' 失败 (exit '+String(code)+')：'+tail.slice(-1200)))}) }) }
async function downloadPinnedArchive(repo:string,commit:string,staging:string,onOutput:(text:string)=>void):Promise<void>{
  const parsed=new URL(repo);if(parsed.hostname!=='github.com')throw new Error('Git 拉取失败且该仓库不支持 GitHub 固定归档回退');const parts=parsed.pathname.replace(/\.git$/,'').split('/').filter(Boolean);const owner=parts[0],repoName=parts[1];if(owner===undefined||repoName===undefined||parts.length!==2)throw new Error('GitHub 仓库地址无效');const archiveUrl='https://codeload.github.com/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repoName)+'/zip/'+encodeURIComponent(commit);onOutput('Git 不可用，切换到固定 commit 归档');const response=await fetch(archiveUrl,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('固定版本归档下载失败: HTTP '+response.status);const total=Number(response.headers.get('content-length')||0);const reader=response.body?.getReader();if(reader===undefined)throw new Error('固定版本归档响应没有数据');const chunks:Uint8Array[]=[];let received=0;while(true){const result=await reader.read();if(result.done)break;chunks.push(result.value);received+=result.value.byteLength;onOutput(total>0?'归档下载 '+Math.floor(received*100/total)+'% ('+received+'/'+total+' bytes)':'归档下载 '+received+' bytes')}const archive=join(staging,'..archive.zip');const expanded=join(staging,'..archive');await rm(archive,{force:true});await rm(expanded,{recursive:true,force:true});await writeFile(archive,Buffer.concat(chunks));await mkdir(expanded,{recursive:true});await extract(archive,{dir:expanded});const entries=await readdir(expanded,{withFileTypes:true});const roots=entries.filter(entry=>entry.isDirectory());const archiveRoot=roots[0];if(archiveRoot===undefined||roots.length!==1)throw new Error('固定版本归档结构无效');await rm(staging,{recursive:true,force:true});await cp(join(expanded,archiveRoot.name),staging,{recursive:true});await rm(archive,{force:true});await rm(expanded,{recursive:true,force:true})
}
export class ShellSkinStore {
  private stateValue:ShellSkinState={activeSkinId:null,installed:{}}; private catalogValue:ShellSkinEntry[]=[]; private readonly previewCache=new Map<string,{dataUrl:string;bytes:number}>(); private previewCacheBytes=0
  constructor(readonly root:string, private readonly catalogUrl=CATALOG_URL, private readonly onProgress:(progress:ShellSkinProgress)=>void=()=>{}){}
  async initialize():Promise<void>{ await mkdir(join(this.root,'packages'),{recursive:true}); try{this.stateValue=JSON.parse(await readFile(join(this.root,'state.json'),'utf8')) as ShellSkinState}catch{}; for(const item of Object.values(this.stateValue.installed)){if(typeof item.installedAt!=='number'||!Number.isFinite(item.installedAt)){try{item.installedAt=(await stat(item.directory)).mtimeMs}catch{item.installedAt=0}} try{const bundle=await readFile(resolve(item.directory,item.clientPath),'utf8');const error=isInjectableClientBundle(bundle)?clientCompatibilityError(bundle):'缺少标准 ModuleLoader/apply 导出';item.compatible=error===undefined;if(error===undefined)delete item.error;else item.error=error}catch(error){item.compatible=false;item.error=error instanceof Error?error.message:String(error)}} if(this.stateValue.activeSkinId!==null&&!this.stateValue.installed[this.stateValue.activeSkinId]?.compatible)this.stateValue.activeSkinId=null; await this.save(); await this.refreshCatalog() }
  async refreshCatalog():Promise<ShellSkinEntry[]>{ const response=await fetch(this.catalogUrl,{signal:AbortSignal.timeout(15000)}); if(!response.ok) throw new Error('皮肤目录请求失败: '+response.status); const value=await response.json() as {skins?:unknown}; if(!Array.isArray(value.skins)) throw new Error('皮肤目录格式无效'); this.catalogValue=value.skins.filter((v):v is ShellSkinEntry=>typeof v==='object'&&v!==null&&typeof (v as ShellSkinEntry).id==='string'&&typeof (v as ShellSkinEntry).repo==='string'&&typeof (v as ShellSkinEntry).install?.commit==='string'); return this.catalogValue }
  list(){ const activeSkinId=this.stateValue.activeSkinId;const skins=this.catalogValue.map(s=>({...s,screenshots:s.screenshots?.map((_,index)=>String(index)),runtime:this.runtime(s.id)}));skins.sort((left,right)=>{if(left.id===activeSkinId)return -1;if(right.id===activeSkinId)return 1;const leftInstalled=left.runtime!==null,rightInstalled=right.runtime!==null;if(leftInstalled!==rightInstalled)return leftInstalled?-1:1;if(left.runtime!==null&&right.runtime!==null)return (right.runtime.installedAt??0)-(left.runtime.installedAt??0);return 0});return {skins,activeSkinId} }
  async preview(id:string,index:number):Promise<string>{ const skin=this.entry(id);if(!Number.isSafeInteger(index)||index<0)throw new Error('预览图序号无效');const source=skin.screenshots?.[index];if(typeof source!=='string')throw new Error('预览图不存在');const parsed=new URL(source);if(parsed.protocol!=='https:'||!PREVIEW_HOSTS.has(parsed.hostname))throw new Error('预览图来源不受信任');const cached=this.previewCache.get(source);if(cached!==undefined){this.previewCache.delete(source);this.previewCache.set(source,cached);return cached.dataUrl}const response=await fetch(source,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('预览图请求失败: '+response.status);const finalUrl=response.url?new URL(response.url):parsed;if(finalUrl.protocol!=='https:'||!PREVIEW_HOSTS.has(finalUrl.hostname))throw new Error('预览图重定向来源不受信任');const contentType=(response.headers.get('content-type')??'').split(';',1)[0]!.trim().toLowerCase();if(!PREVIEW_TYPES.has(contentType))throw new Error('预览图响应类型无效');const declared=Number(response.headers.get('content-length')??0);if(Number.isFinite(declared)&&declared>MAX_PREVIEW_BYTES)throw new Error('预览图超过 12 MB 限制');const body=Buffer.from(await response.arrayBuffer());if(body.length===0)throw new Error('预览图响应为空');if(body.length>MAX_PREVIEW_BYTES)throw new Error('预览图超过 12 MB 限制');const dataUrl='data:'+contentType+';base64,'+body.toString('base64');while(this.previewCacheBytes+body.length>MAX_PREVIEW_CACHE_BYTES&&this.previewCache.size>0){const oldest=this.previewCache.entries().next().value as [string,{dataUrl:string;bytes:number}]|undefined;if(oldest===undefined)break;this.previewCache.delete(oldest[0]);this.previewCacheBytes-=oldest[1].bytes}this.previewCache.set(source,{dataUrl,bytes:body.length});this.previewCacheBytes+=body.length;return dataUrl }
  private entry(id:string){ const found=this.catalogValue.find(s=>s.id===safeId(id)); if(!found) throw new Error('皮肤不在市场目录中'); return found }
  private runtime(id:string){ const item=this.stateValue.installed[id]; if(item?.error?.startsWith('需要 DSH 客户端模块：')||item?.error?.startsWith('需要完整 DSH Client 上下文：')){item.compatible=true;delete item.error} return item??null }
  private async save(){ const temp=join(this.root,'state.json.tmp'); await writeFile(temp,JSON.stringify(this.stateValue,null,2)); await rename(temp,join(this.root,'state.json')) }
  async install(id:string){ const skin=this.entry(id);const started=Date.now();const emit=(phase:ShellSkinProgress['phase'],message:string,detail?:string)=>this.onProgress({skinId:id,phase,message,...(detail?{detail}:{}),elapsedMs:Date.now()-started}); const target=join(this.root,'packages',safeId(id));const staging=target+'.staging';try{emit('prepare','正在清理临时目录');await rm(staging,{recursive:true,force:true});await mkdir(staging,{recursive:true});const output=(detail:string)=>emit('download','正在下载固定版本',detail);try{await run('git',['init'],staging,output);await run('git',['remote','add','origin',skin.repo],staging,output);await run('git',['fetch','--depth','1','--progress','origin',skin.install.commit],staging,output);await run('git',['checkout','--detach','FETCH_HEAD'],staging,output)}catch(gitError){output(gitError instanceof Error?gitError.message:String(gitError));await downloadPinnedArchive(skin.repo,skin.install.commit,staging,output)}emit('validate','正在校验客户端 bundle');const source=skin.subpath?resolve(staging,skin.subpath):resolve(staging);if(skin.subpath&&!source.startsWith(resolve(staging)+sep))throw new Error('皮肤子路径非法');const clientPath=await resolveClientPackage(skin,source,output);const clientFile=resolve(source,clientPath);const bundle=await readFile(clientFile,'utf8');if(!isInjectableClientBundle(bundle))throw new Error('皮肤客户端 bundle 不支持壳注入：缺少标准 ModuleLoader/apply 导出');const compatibilityError=clientCompatibilityError(bundle);emit('copy','正在写入壳皮肤目录');await rm(target,{recursive:true,force:true});if(skin.subpath){await mkdir(target,{recursive:true});await cp(source,target,{recursive:true})}else await rename(staging,target);await rm(staging,{recursive:true,force:true});this.stateValue.installed[id]={version:skin.install.version,directory:target,clientPath,compatible:compatibilityError===undefined,installedAt:Date.now(),...(compatibilityError?{error:compatibilityError}:{})};await this.save();emit('complete','安装完成');return this.list()}catch(error){await rm(staging,{recursive:true,force:true});emit('failed','安装失败',error instanceof Error?error.message:String(error));throw error} }
  async activate(id:string){const installed=this.runtime(id);if(!installed?.compatible)throw new Error('请先安装兼容皮肤');this.stateValue.activeSkinId=id;await this.save();return this.activeClientBundle()}
  async deactivate(){this.stateValue.activeSkinId=null;await this.save();return this.list()}
  async uninstall(id:string){safeId(id);if(this.stateValue.activeSkinId===id)this.stateValue.activeSkinId=null;const item=this.stateValue.installed[id];if(item)await rm(item.directory,{recursive:true,force:true});delete this.stateValue.installed[id];await this.save();return this.list()}
  async activeClientBundle():Promise<{id:string;bundle:string}|null>{const id=this.stateValue.activeSkinId;if(!id)return null;const item=this.stateValue.installed[id];if(!item?.compatible)return null;return{id,bundle:await readFile(resolve(item.directory,item.clientPath),'utf8')}}
  async readAsset(id:string,path:string):Promise<{body:Buffer;contentType:string}>{safeId(id);const item=this.stateValue.installed[id];if(!item?.compatible)throw new Error('皮肤未安装');return resolveShellSkinAsset(item.directory,path)}
}
